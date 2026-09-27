import 'dart:async';
import 'dart:math';

import 'constants.dart';
import 'credentials.dart';
import 'exception.dart';
import 'protocol/messages.dart';
import 'protocol/packet.dart';
import 'transport/connection.dart';
import 'transport/link.dart';

/// An interactive ET terminal session.
///
/// Port of the terminal half of upstream `TerminalClient`: sends
/// `INITIAL_PAYLOAD`, relays `TERMINAL_BUFFER` both ways, reports window
/// size with `TERMINAL_INFO`, and probes the link with `KEEP_ALIVE`.
class EtSession {
  EtSession._(this._connection, this.keepAlive) {
    _subscription = _connection.packets.listen(
      _handlePacket,
      onDone: _handleConnectionDone,
    );
    _stateSubscription = _connection.states.listen((state) {
      _waitingOnKeepAlive = false;
      _lastReceive.reset();
    });
  }

  /// Connects to etserver with [credentials] obtained via SSH bootstrap.
  static Future<EtSession> connect({
    required String host,
    int port = etDefaultPort,
    required EtCredentials credentials,
    int columns = 80,
    int rows = 24,
    Duration keepAlive = etDefaultKeepAlive,
    Duration connectTimeout = const Duration(seconds: 10),
    Duration handshakeTimeout = const Duration(seconds: 10),
    Duration retryDelay = const Duration(seconds: 1),
    EtSocketConnector connector = defaultEtSocketConnector,
  }) async {
    final connection = await EtConnection.connect(
      host: host,
      port: port,
      credentials: credentials,
      connector: connector,
      connectTimeout: connectTimeout,
      handshakeTimeout: handshakeTimeout,
      retryDelay: retryDelay,
    );
    final session = EtSession._(connection, keepAlive);
    try {
      if (!connection.resumedExistingSession) {
        await session._sendInitialPayload(handshakeTimeout);
      }
      session.resize(columns, rows);
      session._startKeepAlive();
    } catch (_) {
      await session._shutdown(null);
      rethrow;
    }
    return session;
  }

  /// Chunk size for terminal input; keeps single packets small.
  static const int maxInputChunk = 16 * 1024;

  /// Quiet period after which a `KEEP_ALIVE` probe is sent.
  final Duration keepAlive;

  final EtConnection _connection;
  late final StreamSubscription<EtPacket> _subscription;
  late final StreamSubscription<EtConnectionState> _stateSubscription;
  final _stdout = StreamController<List<int>>.broadcast();
  final _stderr = StreamController<List<int>>.broadcast();
  final _done = Completer<void>();
  final _lastReceive = Stopwatch()..start();
  Completer<void>? _initialResponse;
  Timer? _keepAliveTimer;
  var _waitingOnKeepAlive = false;
  int? _exitCode;
  int? _columns;
  int? _rows;

  /// Remote terminal output.
  Stream<List<int>> get stdout => _stdout.stream;

  /// Remote stderr (only used by no-pty sessions).
  Stream<List<int>> get stderr => _stderr.stream;

  /// Link state changes; useful for a "reconnecting…" banner.
  Stream<EtConnectionState> get states => _connection.states;

  /// Current link state.
  EtConnectionState get state => _connection.state;

  /// Completes when the session ends (shell exit, rejection, or [close]).
  Future<void> get done => _done.future;

  /// Exit status of the remote shell, when the server reported one.
  int? get exitCode => _exitCode;

  /// Why the session ended, or `null` for a normal end.
  Object? get closeReason => _connection.closeReason;

  /// Sends terminal input (keystrokes, pastes).
  void send(List<int> data) {
    for (var offset = 0; offset < data.length; offset += maxInputChunk) {
      final end = min(offset + maxInputChunk, data.length);
      _write(
        EtPacketType.terminalBuffer,
        EtTerminalBuffer(data.sublist(offset, end)).encode(),
      );
    }
  }

  /// Reports a new window size. Duplicate sizes are not sent.
  void resize(int columns, int rows) {
    if (columns <= 0 || rows <= 0) {
      throw EtException('Invalid terminal size: ${columns}x$rows.');
    }
    if (columns == _columns && rows == _rows) return;
    _columns = columns;
    _rows = rows;
    _write(
      EtPacketType.terminalInfo,
      EtTerminalInfo(rows: rows, columns: columns).encode(),
    );
  }

  /// Forces a fresh TCP link (e.g. after the app returns to the foreground).
  void reconnect() => _connection.reconnectNow();

  /// True when [close] can end the remote shell (`TERMINAL_CLOSE`).
  ///
  /// etserver 7.0.0 does not know that packet and crashes the whole server
  /// on it, so it is only sent to servers newer than 7.0.0.
  bool get canTerminateRemote => _connection.serverUsesChallenge;

  /// Ends the session. With [terminate], the remote shell is closed too when
  /// the server supports it (see [canTerminateRemote]).
  Future<void> close({bool terminate = true}) async {
    if (_done.isCompleted) return;
    if (terminate &&
        canTerminateRemote &&
        _connection.state == EtConnectionState.connected) {
      _write(EtPacketType.terminalClose, const []);
      await _connection.close(flush: true);
    }
    await _shutdown(null);
  }

  Future<void> _sendInitialPayload(Duration timeout) async {
    final response = Completer<void>();
    _initialResponse = response;
    _write(EtPacketType.initialPayload, const EtInitialPayload().encode());
    try {
      await response.future.timeout(timeout);
    } on TimeoutException {
      throw const EtException('Timed out waiting for INITIAL_RESPONSE.');
    }
  }

  void _startKeepAlive() {
    final tick = Duration(milliseconds: max(50, keepAlive.inMilliseconds ~/ 5));
    _keepAliveTimer = Timer.periodic(tick, (_) => _checkKeepAlive());
  }

  void _checkKeepAlive() {
    if (_connection.state != EtConnectionState.connected) return;
    if (_lastReceive.elapsed < keepAlive) return;
    _lastReceive.reset();
    if (_waitingOnKeepAlive) {
      // No echo within two quiet periods: the link is dead.
      _waitingOnKeepAlive = false;
      _connection.reconnectNow();
    } else {
      _waitingOnKeepAlive = true;
      _write(EtPacketType.keepAlive, const []);
    }
  }

  void _handlePacket(EtPacket packet) {
    _lastReceive.reset();
    switch (packet.header) {
      case EtPacketType.initialResponse:
        final response = EtInitialResponse.decode(packet.payload);
        final waiter = _initialResponse;
        _initialResponse = null;
        if (waiter == null || waiter.isCompleted) return;
        final error = response.error;
        if (error != null) {
          waiter.completeError(
            EtException('Server refused the session: $error'),
          );
        } else {
          waiter.complete();
        }
      case EtPacketType.terminalBuffer:
        final buffer = EtTerminalBuffer.decode(packet.payload);
        (buffer.isStderr ? _stderr : _stdout).add(buffer.buffer);
      case EtPacketType.keepAlive:
        _waitingOnKeepAlive = false;
      case EtPacketType.terminalExitStatus:
        _exitCode = EtTerminalExitStatus.decode(packet.payload).exitCode;
        // The server closes the session right after this packet.
        unawaited(_shutdown(null));
      default:
        // Port forwarding and heartbeat packets are not supported (yet).
        break;
    }
  }

  void _handleConnectionDone() {
    final waiter = _initialResponse;
    if (waiter != null && !waiter.isCompleted) {
      waiter.completeError(
        _connection.closeReason ?? const EtException('Connection closed.'),
      );
    }
    unawaited(_shutdown(_connection.closeReason));
  }

  void _write(int header, List<int> payload) {
    if (_done.isCompleted) {
      throw const EtException('The ET session is closed.');
    }
    _connection.write(EtPacket(header, payload));
  }

  Future<void> _shutdown(Object? reason) async {
    if (_done.isCompleted) return;
    _done.complete();
    _keepAliveTimer?.cancel();
    await _connection.close();
    await _subscription.cancel();
    await _stateSubscription.cancel();
    await _stdout.close();
    await _stderr.close();
  }
}
