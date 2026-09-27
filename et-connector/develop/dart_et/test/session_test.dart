import 'dart:async';
import 'dart:convert';

import 'package:dart_et/dart_et.dart';
import 'package:test/test.dart';

import 'support/fake_et_server.dart';

/// Collects stdout into a string and lets tests wait for a substring.
class OutputSink {
  OutputSink(Stream<List<int>> stream) {
    stream.listen((b) {
      text += utf8.decode(b);
      _changes.add(null);
    });
  }

  String text = '';
  final _changes = StreamController<void>.broadcast();

  Future<void> waitFor(String needle) async {
    if (text.contains(needle)) return;
    await _changes.stream
        .firstWhere((_) => text.contains(needle))
        .timeout(const Duration(seconds: 5));
  }
}

void main() {
  late EtCredentials creds;
  late FakeEtServer server;

  Future<EtSession> connect({Duration keepAlive = etDefaultKeepAlive}) =>
      EtSession.connect(
        host: '127.0.0.1',
        port: server.port,
        credentials: creds,
        columns: 100,
        rows: 30,
        keepAlive: keepAlive,
        retryDelay: const Duration(milliseconds: 50),
      );

  setUp(() async {
    creds = EtCredentials.random();
    server = await FakeEtServer.start(credentials: creds);
  });

  tearDown(() => server.close());

  test('sends INITIAL_PAYLOAD first, then the window size', () async {
    final session = await connect();
    await server.onPacket.firstWhere(
      (p) => p.header == EtPacketType.terminalInfo,
    );
    expect(server.received.first.header, EtPacketType.initialPayload);
    await session.close(terminate: false);
  });

  test('relays input and output', () async {
    final session = await connect();
    final out = OutputSink(session.stdout);
    session.send(utf8.encode('ls\r'));
    await out.waitFor('echo:ls\r');
    await session.close(terminate: false);
  });

  test('works with a legacy (pre-7.0) server handshake', () async {
    await server.close();
    server = await FakeEtServer.start(credentials: creds, challenge: false);
    final session = await connect();
    final out = OutputSink(session.stdout);
    session.send(utf8.encode('hi'));
    await out.waitFor('echo:hi');
    await session.close(terminate: false);
  });

  test('replays both directions after the link drops', () async {
    final session = await connect();
    final out = OutputSink(session.stdout);
    session.send(utf8.encode('before'));
    await out.waitFor('echo:before');

    server.dropLink();
    // Output produced by the server while the client is offline...
    server.sendOutput(utf8.encode('while-offline'));
    // ...and input typed by the user while offline.
    await session.states.firstWhere((s) => s == EtConnectionState.reconnecting);
    session.send(utf8.encode('typed-offline'));

    await session.states.firstWhere((s) => s == EtConnectionState.connected);
    await out.waitFor('while-offline');
    await out.waitFor('echo:typed-offline');
    expect(server.handshakes, 2);
    // Nothing was delivered twice.
    expect('echo:before'.allMatches(out.text), hasLength(1));
    await session.close(terminate: false);
  });

  test('reconnect() forces a fresh link without losing data', () async {
    final session = await connect();
    final out = OutputSink(session.stdout);
    session.reconnect();
    session.send(utf8.encode('after-foreground'));
    await out.waitFor('echo:after-foreground');
    expect(server.handshakes, 2);
    await session.close(terminate: false);
  });

  test('keepalive detects a black-holed link and reconnects', () async {
    final session = await connect(keepAlive: const Duration(milliseconds: 200));
    server.echoKeepAlive = false;
    await server.onAttach
        .firstWhere((n) => n == 2)
        .timeout(const Duration(seconds: 5));
    server.echoKeepAlive = true;
    expect(session.state, EtConnectionState.connected);
    await session.close(terminate: false);
  });

  test('close() tears down the TCP link (no leaked socket)', () async {
    final session = await connect();
    await session.close(terminate: false);
    // The fake server notices the peer closing and drops its link.
    for (var i = 0; i < 50 && server.isConnected; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(server.isConnected, isFalse);
  });

  test('reconnect() skips the pending retry delay', () async {
    final session = await EtSession.connect(
      host: '127.0.0.1',
      port: server.port,
      credentials: creds,
      retryDelay: const Duration(seconds: 30),
    );
    // Make the first redial fail so the loop sleeps for retryDelay (30 s).
    server.retryLater = true;
    final refused = server.onRetryLater.first;
    server.dropLink();
    await refused;
    server.retryLater = false;
    final connected = session.states.firstWhere(
      (s) => s == EtConnectionState.connected,
    );
    session.reconnect();
    await connected.timeout(const Duration(seconds: 5));
    await session.close(terminate: false);
  });

  test('ends with the exit code the server reports', () async {
    final session = await connect();
    server.send(
      EtPacket(
        EtPacketType.terminalExitStatus,
        const EtTerminalExitStatus(3).encode(),
      ),
    );
    await session.done.timeout(const Duration(seconds: 5));
    expect(session.exitCode, 3);
  });

  test('ends when the server has forgotten the session', () async {
    final session = await connect();
    server.sessionKnown = false;
    server.dropLink();
    await session.done.timeout(const Duration(seconds: 5));
    expect(session.closeReason, isA<EtSessionEndedException>());
  });

  test(
    'close() never sends TERMINAL_CLOSE to a 7.0.0 (legacy) server',
    () async {
      await server.close();
      server = await FakeEtServer.start(credentials: creds, challenge: false);
      final session = await connect();
      expect(session.canTerminateRemote, isFalse);
      await session.close();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(
        server.received.map((p) => p.header),
        isNot(contains(EtPacketType.terminalClose)),
      );
    },
  );

  test('close(terminate: true) sends TERMINAL_CLOSE', () async {
    final session = await connect();
    await session.close();
    await server.onPacket
        .firstWhere((p) => p.header == EtPacketType.terminalClose)
        .timeout(const Duration(seconds: 5));
  });

  test('rejects wrong credentials at connect time', () async {
    expect(
      EtSession.connect(
        host: '127.0.0.1',
        port: server.port,
        credentials: EtCredentials.random(),
      ),
      throwsA(isA<EtSessionEndedException>()),
    );
  });
}
