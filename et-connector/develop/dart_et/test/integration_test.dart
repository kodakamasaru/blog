// Runs against a real etserver reached through SSH.
//
//   ET_IT_TARGET=dev@127.0.0.1 ET_IT_SSH_ARGS="-i key -p 2222 -o StrictHostKeyChecking=no" \
//     dart test test/integration_test.dart
//
// See ../server/Dockerfile for a disposable etserver + sshd container.
@Tags(['integration'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dart_et/dart_et.dart';
import 'package:test/test.dart';

void main() {
  final target = Platform.environment['ET_IT_TARGET'];
  final sshArgs = (Platform.environment['ET_IT_SSH_ARGS'] ?? '')
      .split(' ')
      .where((a) => a.isNotEmpty)
      .toList();
  final port = int.parse(
    Platform.environment['ET_IT_PORT'] ?? '$etDefaultPort',
  );

  Future<EtSession> open() async {
    final ssh = await Process.run('ssh', [
      ...sshArgs,
      target!,
      const EtSshBootstrap().command(EtCredentials.random()),
    ]);
    return EtSession.connect(
      host: target.split('@').last,
      port: port,
      credentials: EtCredentials.parse('${ssh.stdout}'),
      columns: 132,
      rows: 43,
      retryDelay: const Duration(milliseconds: 200),
    );
  }

  Future<String> collectUntil(
    EtSession session,
    String needle,
    StringBuffer sink,
  ) => session.stdout
      .map((b) => sink..write(utf8.decode(b, allowMalformed: true)))
      .firstWhere((s) => s.toString().contains(needle))
      .then((s) => s.toString())
      .timeout(const Duration(seconds: 10));

  test('runs a command and reports the window size', () async {
    final session = await open();
    final out = StringBuffer();
    final done = collectUntil(session, 'SIZE=43x132', out);
    session.send(utf8.encode('echo SIZE=\$(tput lines)x\$(tput cols)\r'));
    await done;
    await session.close();
  }, skip: target == null ? 'set ET_IT_TARGET to run' : null);

  test('survives a forced reconnect mid-output', () async {
    final session = await open();
    final out = StringBuffer();
    // The marker is computed remotely so the echoed command cannot match it.
    final done = collectUntil(session, 'END-OF-42', out);
    session.send(
      utf8.encode(
        'for i in \$(seq 1 30); do echo T\$i; sleep 0.05; done; echo END-OF-\$((40+2))\r',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 500));
    session.reconnect();
    final text = await done;
    for (var i = 1; i <= 30; i++) {
      expect(
        RegExp('^T$i\\r?\$', multiLine: true).allMatches(text),
        hasLength(1),
        reason: 'tick $i should appear exactly once',
      );
    }
    await session.close();
  }, skip: target == null ? 'set ET_IT_TARGET to run' : null);

  test('ends when the remote shell exits', () async {
    final session = await open();
    session.send(utf8.encode('exit\r'));
    await session.done.timeout(const Duration(seconds: 15));
  }, skip: target == null ? 'set ET_IT_TARGET to run' : null);
}
