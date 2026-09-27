import 'dart:async';
import 'dart:typed_data';

import '../constants.dart';
import '../credentials.dart';
import '../crypto/auth_proof.dart';
import '../crypto/et_cipher.dart';
import '../exception.dart';
import '../protocol/messages.dart';
import '../protocol/packet.dart';
import 'backed_reader.dart';
import 'backed_writer.dart';
import 'byte_queue.dart';
import 'framing.dart';
import 'link.dart';

/// Lifecycle of an [EtConnection].
enum EtConnectionState { connected, reconnecting, closed }

/// Reliable, ordered, encrypted packet stream that survives reconnects.
///
/// Port of upstream `ClientConnection` (EternalTCP). Packets written while
/// the TCP link is down are buffered; after a reconnect both sides exchange
/// how many packets they received and replay the rest.
class EtConnection {
  EtConnection._({
    required this.host,
    required this.port,
    required EtCredentials credentials,
    required EtSocketConnector connector,
    required this.connectTimeout,
    required this.handshakeTimeout,
    required this.retryDelay,
  }) : _id = credentials.id,
       _key = Uint8List.fromList(credentials.passkey.codeUnits),
       _connector = connector {
    _writer = BackedWriter(EtCipher(_key, etClientServerNonceMsb));
    _reader = BackedReader(EtCipher(_key, etServerClientNonceMsb));
  }

  /// Connects and completes the first handshake.
  static Future<EtConnection> connect({
    required String host,
    int port = etDefaultPort,
    required EtCredentials credentials,
    EtSocketConnector connector = defaultEtSocketConnector,
    Duration connectTimeout = const Duration(seconds: 10),
    Duration handshakeTimeout = const Duration(seconds: 10),
    Duration retryDelay = const Duration(seconds: 1),
  }) async {
    final connection = EtConnection._(
      host: host,
      port: port,
      credentials: credentials,
      connector: connector,
      connectTimeout: connectTimeout,
      handshakeTimeout: handshakeTimeout,
      retryDelay: retryDelay,
    );
    await connection._initialConnect();
    return connection;
  }

  /// Server host name or address.
  final String host;

  /// Server TCP port.
  final int port;

  /// Timeout for each TCP connect.
  final Duration connectTimeout;

  /// Timeout for each handshake / recovery exchange.
  final Duration handshakeTimeout;

  /// Pause between reconnect attempts.
  final Duration retryDelay;

  final String _id;
  final Uint8List _key;
  final EtSocketConnector _connector;
  late final BackedWriter _writer;
  late final BackedReader _reader;

  final _packets = StreamController<EtPacket>();
  final _states = StreamController<EtConnectionState>.broadcast();
  final _done = Completer<void>();
  EtLink? _link;
  var _generation = 0;
  var _reconnecting = false;
  Completer<void>? _retryWake;
  var _skipNextDelay = false;
  var _state = EtConnectionState.connected;
  var _resumed = false;
  var _serverUsesChallenge = false;
  Object? _closeReason;

  /// Decrypted packets from the server, in order, across reconnects.
  Stream<EtPacket> get packets => _packets.stream;

  /// State changes (connected / reconnecting / closed).
  Stream<EtConnectionState> get states => _states.stream;

  /// Current state.
  EtConnectionState get state => _state;

  /// Completes once the connection is closed for good.
  Future<void> get done => _done.future;

  /// Why the connection closed: `null` for [close], otherwise the error.
  Object? get closeReason => _closeReason;

  /// True when the first connect resumed a session the server already ran.
  bool get resumedExistingSession => _resumed;

  /// True when the server used the post-7.0 challenge handshake.
  ///
  /// Such servers also understand the packet types added after 7.0.0
  /// (e.g. `TERMINAL_CLOSE`); etserver 7.0.0 aborts on unknown types.
  bool get serverUsesChallenge => _serverUsesChallenge;

  /// Queues [packet]. It is sent now or replayed after a reconnect.
  void write(EtPacket packet) {
    if (_state == EtConnectionState.closed) {
      throw const EtException('The ET connection is closed.');
    }
    final link = _link;
    final wire = _writer.write(packet, connected: link != null);
    link?.add(framePacket(wire));
  }

  /// Drops the current TCP link and reconnects right away.
  ///
  /// Call this when the app returns to the foreground or the network
  /// changes: the old socket may look alive long after it died.
  void reconnectNow() {
    // Skip the retry delay if a reconnect loop is already running, whether
    // it is sleeping now or mid-attempt (checked before the next sleep).
    _skipNextDelay = true;
    final wake = _retryWake;
    if (wake != null && !wake.isCompleted) wake.complete();
    _linkLost(_generation, 'reconnect requested');
  }

  /// Closes the connection. With [flush], queued bytes are sent first.
  Future<void> close({bool flush = false}) async {
    if (_state == EtConnectionState.closed) return;
    final link = _link;
    if (flush && link != null) {
      await link.closeGracefully(const Duration(seconds: 2));
    }
    // _finish destroys _link, which is still set when flush was false.
    _finish(null);
  }

  Future<void> _initialConnect() async {
    final link = EtLink(await _connector(host, port, connectTimeout));
    try {
      final response = await _handshake(link).timeout(handshakeTimeout);
      switch (response.status) {
        case EtConnectStatus.newClient:
          _attach(link, const []);
        case EtConnectStatus.returningClient:
          // The server already has this id (e.g. it survived a restart).
          final replay = await _recover(
            link,
            response,
          ).timeout(handshakeTimeout);
          _resumed = response.resetRequired;
          _attach(link, replay);
        default:
          throw _rejection(response);
      }
    } catch (_) {
      link.destroy();
      rethrow;
    }
  }

  Future<EtConnectResponse> _handshake(EtLink link) async {
    link.add(frameProto(EtConnectRequest(clientId: _id).encode()));
    final first = EtConnectResponse.decode(await readProto(link.queue));
    final challenge = first.authChallenge;
    if (challenge == null) {
      // Pre-7.0 server or unknown client: legacy handshake, no reset fields.
      return EtConnectResponse(status: first.status, error: first.error);
    }
    _serverUsesChallenge = true;
    if (challenge.length != etAuthChallengeLength) {
      throw const EtException(
        'Server sent an invalid authentication challenge.',
      );
    }
    final proof = EtAuthProof.connection(
      key: _key,
      clientId: _id,
      challenge: challenge,
      resetIntent: false,
    );
    link.add(frameProto(EtConnectAuth(proof).encode()));
    final response = EtConnectResponse.decode(await readProto(link.queue));
    final status = response.status;
    if (status == EtConnectStatus.newClient ||
        status == EtConnectStatus.returningClient) {
      _verifyResetDecision(response, challenge);
    }
    return response;
  }

  void _verifyResetDecision(EtConnectResponse response, Uint8List challenge) {
    final salt = response.resetSalt ?? Uint8List(0);
    final saltValid = response.resetRequired
        ? salt.length == etEpochSaltLength
        : salt.isEmpty;
    final proof = response.resetProof;
    if (!saltValid || proof == null) {
      throw const EtException(
        'Connect success is missing a valid reset decision.',
      );
    }
    final expected = EtAuthProof.resetDecision(
      key: _key,
      clientId: _id,
      challenge: challenge,
      status: response.status!,
      resetRequired: response.resetRequired,
      resetSalt: salt,
    );
    if (!EtAuthProof.equals(proof, expected)) {
      throw const EtException('Server reset decision proof does not match.');
    }
  }

  /// Runs the SequenceHeader / CatchupBuffer exchange on a returning link.
  Future<List<EtPacket>> _recover(
    EtLink link,
    EtConnectResponse response,
  ) async {
    final queue = link.queue;
    if (response.resetRequired) {
      final salt = response.resetSalt!;
      link.add(
        frameProto(
          EtSequenceHeader(
            sequenceNumber: 0,
            reset: true,
            resetSalt: salt,
          ).encode(),
        ),
      );
      final remote = EtSequenceHeader.decode(await readProto(queue));
      if (!remote.reset ||
          !EtAuthProof.equals(remote.resetSalt ?? const [], salt)) {
        throw const EtException(
          'Reset request does not match the negotiated salt.',
        );
      }
      link.add(frameProto(const EtCatchupBuffer([]).encode()));
      await readProto(queue, maxLength: etMaxMessageLength);
      _writer.reset(salt);
      _reader.reset(salt);
      return const [];
    }

    link.add(
      frameProto(
        EtSequenceHeader(sequenceNumber: _reader.sequenceNumber).encode(),
      ),
    );
    final remote = EtSequenceHeader.decode(await readProto(queue));
    if (remote.reset || (remote.resetSalt?.isNotEmpty ?? false)) {
      throw const EtException('Unexpected reset request from server.');
    }
    final local = _writer.recover(remote.sequenceNumber);
    // Upstream clients read the peer's catchup first, then send theirs.
    final catchup = EtCatchupBuffer.decode(
      await readProto(queue, maxLength: etMaxMessageLength),
    );
    link.add(frameProto(EtCatchupBuffer(local).encode()));
    // Packets written while we awaited are numbered after `local`.
    final writtenMeanwhile = _writer.recover(
      remote.sequenceNumber + local.length,
    );
    for (final wire in writtenMeanwhile) {
      link.add(framePacket(wire));
    }
    return [for (final wire in catchup.buffers) _reader.decode(wire)];
  }

  void _attach(EtLink link, List<EtPacket> replay) {
    final generation = ++_generation;
    _link = link;
    replay.forEach(_packets.add);
    _setState(EtConnectionState.connected);
    unawaited(_readLoop(link, generation));
  }

  Future<void> _readLoop(EtLink link, int generation) async {
    try {
      while (generation == _generation) {
        final wire = await readPacketFrame(link.queue);
        if (generation != _generation) return;
        _packets.add(_reader.decode(wire));
      }
    } on EtLinkClosedException catch (error) {
      _linkLost(generation, error);
    } catch (error) {
      // Integrity failures (bad MAC, oversized frame) cannot be resumed.
      if (generation == _generation) _finish(error);
    }
  }

  void _linkLost(int generation, Object reason) {
    if (generation != _generation || _state == EtConnectionState.closed) return;
    _generation++;
    _link?.destroy();
    _link = null;
    _setState(EtConnectionState.reconnecting);
    unawaited(_reconnectLoop());
  }

  Future<void> _reconnectLoop() async {
    if (_reconnecting) return;
    _reconnecting = true;
    try {
      while (_state != EtConnectionState.closed) {
        _skipNextDelay = false;
        if (await _tryReconnect()) return;
        if (_skipNextDelay) continue;
        final wake = _retryWake = Completer<void>();
        final timer = Timer(retryDelay, () {
          if (!wake.isCompleted) wake.complete();
        });
        await wake.future;
        timer.cancel();
        _retryWake = null;
      }
    } finally {
      _reconnecting = false;
    }
  }

  /// One reconnect attempt. Returns true when the loop should stop.
  Future<bool> _tryReconnect() async {
    EtLink? link;
    try {
      link = EtLink(await _connector(host, port, connectTimeout));
      final response = await _handshake(link).timeout(handshakeTimeout);
      if (_state == EtConnectionState.closed) {
        link.destroy();
        return true;
      }
      switch (response.status) {
        case EtConnectStatus.returningClient:
          final replay = await _recover(
            link,
            response,
          ).timeout(handshakeTimeout);
          if (_state == EtConnectionState.closed) {
            link.destroy();
            return true;
          }
          _attach(link, replay);
          return true;
        case EtConnectStatus.retryLater:
          link.destroy();
          return false;
        default:
          // INVALID_KEY: the shell exited and the server forgot the session.
          link.destroy();
          _finish(_rejection(response));
          return true;
      }
    } on EtRecoveryException catch (error) {
      link?.destroy();
      _finish(error);
      return true;
    } catch (_) {
      // Network errors and timeouts: try again.
      link?.destroy();
      return false;
    }
  }

  EtException _rejection(EtConnectResponse response) {
    final detail = response.error ?? 'status ${response.status}';
    return switch (response.status) {
      EtConnectStatus.invalidKey => EtSessionEndedException(
        'Server does not know this session: $detail',
      ),
      EtConnectStatus.mismatchedProtocol => EtException(
        'Protocol version mismatch: $detail',
      ),
      EtConnectStatus.retryLater => EtException(
        'Server is recovering: $detail',
      ),
      _ => EtException('Server rejected the session: $detail'),
    };
  }

  void _setState(EtConnectionState state) {
    if (_state == state) return;
    _state = state;
    _states.add(state);
  }

  void _finish(Object? reason) {
    if (_state == EtConnectionState.closed) return;
    _closeReason = reason;
    _generation++;
    _link?.destroy();
    _link = null;
    final wake = _retryWake;
    if (wake != null && !wake.isCompleted) wake.complete();
    _setState(EtConnectionState.closed);
    unawaited(_packets.close());
    unawaited(_states.close());
    if (!_done.isCompleted) _done.complete();
  }
}
