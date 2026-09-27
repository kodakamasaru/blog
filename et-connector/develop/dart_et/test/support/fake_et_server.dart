import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:dart_et/dart_et.dart';
import 'package:dart_et/src/transport/backed_reader.dart';
import 'package:dart_et/src/transport/backed_writer.dart';
import 'package:dart_et/src/transport/framing.dart';
import 'package:dart_et/src/transport/link.dart';

/// In-process stand-in for etserver's side of the protocol (tests only).
class FakeEtServer {
  FakeEtServer._(this._server, this.credentials, this.challenge);

  static Future<FakeEtServer> start({
    required EtCredentials credentials,
    bool challenge = true,
  }) async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final fake = FakeEtServer._(server, credentials, challenge);
    server.listen(fake._accept);
    return fake;
  }

  final ServerSocket _server;
  final EtCredentials credentials;
  final bool challenge;
  late final Uint8List _key = Uint8List.fromList(credentials.passkey.codeUnits);

  BackedWriter? _writer;
  BackedReader? _reader;
  EtLink? _link;

  /// When false, new connections get INVALID_KEY.
  bool sessionKnown = true;

  /// When true, new connections get RETRY_LATER (server "restarting").
  bool retryLater = false;
  final _retryLaterSent = StreamController<void>.broadcast();
  Stream<void> get onRetryLater => _retryLaterSent.stream;

  /// When false, KEEP_ALIVE is not echoed (simulates a black-holed link).
  bool echoKeepAlive = true;

  /// Number of successful handshakes (1 = initial, 2+ = reconnects).
  int handshakes = 0;

  final received = <EtPacket>[];
  final _receivedController = StreamController<EtPacket>.broadcast();
  final _attached = StreamController<int>.broadcast();

  int get port => _server.port;
  Stream<EtPacket> get onPacket => _receivedController.stream;
  Stream<int> get onAttach => _attached.stream;
  bool get isConnected => _link != null;

  /// Sends a packet to the client, buffering it while disconnected.
  void send(EtPacket packet) {
    final wire = _writer!.write(packet, connected: _link != null);
    _link?.add(framePacket(wire));
  }

  void sendOutput(List<int> bytes) => send(
    EtPacket(EtPacketType.terminalBuffer, EtTerminalBuffer(bytes).encode()),
  );

  /// Kills the current TCP link without telling the session.
  void dropLink() {
    _link?.destroy();
    _link = null;
  }

  Future<void> close() async {
    dropLink();
    await _server.close();
    await _receivedController.close();
    await _attached.close();
    await _retryLaterSent.close();
  }

  Future<void> _accept(Socket socket) async {
    final link = EtLink(socket);
    try {
      final request = EtConnectRequest.decode(await readProto(link.queue));
      if (!sessionKnown || request.clientId != credentials.id) {
        link.add(
          frameProto(
            const EtConnectResponse(
              status: EtConnectStatus.invalidKey,
              error: 'unknown',
            ).encode(),
          ),
        );
        await link.closeGracefully(const Duration(seconds: 1));
        return;
      }
      if (retryLater) {
        link.add(
          frameProto(
            const EtConnectResponse(
              status: EtConnectStatus.retryLater,
            ).encode(),
          ),
        );
        await link.closeGracefully(const Duration(seconds: 1));
        _retryLaterSent.add(null);
        return;
      }
      final returning = _writer != null;
      final status = returning
          ? EtConnectStatus.returningClient
          : EtConnectStatus.newClient;
      if (challenge && request.supportsChallenge) {
        final nonce = Uint8List.fromList(
          List.generate(32, (_) => Random().nextInt(256)),
        );
        link.add(frameProto(EtConnectResponse(authChallenge: nonce).encode()));
        final auth = EtConnectAuth.decode(await readProto(link.queue));
        final expected = EtAuthProof.connection(
          key: _key,
          clientId: credentials.id,
          challenge: nonce,
          resetIntent: false,
        );
        if (!EtAuthProof.equals(auth.proof, expected)) {
          link.add(
            frameProto(
              const EtConnectResponse(
                status: EtConnectStatus.invalidKey,
              ).encode(),
            ),
          );
          link.destroy();
          return;
        }
        link.add(
          frameProto(
            EtConnectResponse(
              status: status,
              resetProof: EtAuthProof.resetDecision(
                key: _key,
                clientId: credentials.id,
                challenge: nonce,
                status: status,
                resetRequired: false,
                resetSalt: const [],
              ),
            ).encode(),
          ),
        );
      } else {
        link.add(frameProto(EtConnectResponse(status: status).encode()));
      }

      var catchup = const <EtPacket>[];
      if (!returning) {
        _writer = BackedWriter(EtCipher(_key, etServerClientNonceMsb));
        _reader = BackedReader(EtCipher(_key, etClientServerNonceMsb));
      } else {
        dropLink();
        catchup = await _recover(link);
      }
      handshakes++;
      _link = link;
      _attached.add(handshakes);
      // Like upstream BackedReader::revive, catchup is handled after the
      // link is live so replies go out on it.
      catchup.forEach(_handle);
      await _readLoop(link);
    } catch (_) {
      link.destroy();
      if (identical(_link, link)) _link = null;
    }
  }

  Future<List<EtPacket>> _recover(EtLink link) async {
    // Server side of Connection::recover with readPeerCatchupFirst=false.
    link.add(
      frameProto(
        EtSequenceHeader(sequenceNumber: _reader!.sequenceNumber).encode(),
      ),
    );
    final remote = EtSequenceHeader.decode(await readProto(link.queue));
    link.add(
      frameProto(
        EtCatchupBuffer(_writer!.recover(remote.sequenceNumber)).encode(),
      ),
    );
    final catchup = EtCatchupBuffer.decode(
      await readProto(link.queue, maxLength: etMaxMessageLength),
    );
    return [for (final wire in catchup.buffers) _reader!.decode(wire)];
  }

  Future<void> _readLoop(EtLink link) async {
    while (identical(_link, link)) {
      final wire = await readPacketFrame(link.queue);
      _handle(_reader!.decode(wire));
    }
  }

  void _handle(EtPacket packet) {
    received.add(packet);
    _receivedController.add(packet);
    switch (packet.header) {
      case EtPacketType.initialPayload:
        send(
          EtPacket(
            EtPacketType.initialResponse,
            const EtInitialResponse().encode(),
          ),
        );
      case EtPacketType.keepAlive when echoKeepAlive:
        send(EtPacket(EtPacketType.keepAlive));
      case EtPacketType.terminalBuffer:
        final input = EtTerminalBuffer.decode(packet.payload).buffer;
        sendOutput([...'echo:'.codeUnits, ...input]);
    }
  }
}
