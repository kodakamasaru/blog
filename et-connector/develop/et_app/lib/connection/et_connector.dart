import 'dart:async';
import 'dart:convert';

import 'package:dart_et/dart_et.dart';
import 'package:dartssh2/dartssh2.dart';

import 'connection_profile.dart';
import 'host_key_store.dart';

/// Asks the user whether to trust an unknown host key.
typedef TrustPrompt = Future<bool> Function(String fingerprint);

/// Thrown when the host key differs from the one trusted before.
class HostKeyChangedException implements Exception {
  const HostKeyChangedException(this.expected, this.actual);

  final String expected;
  final String actual;

  @override
  String toString() => 'ホスト鍵が以前と違います。\n保存済み: $expected\n今回: $actual';
}

/// SSH で etterminal を起動し、ET セッションを張る。
///
/// SSH は bootstrap（id/passkey の受け取り）にだけ使い、すぐ閉じる。
/// 以降の通信は TCP 2022 の ET だけになる。
class EtConnector {
  EtConnector({HostKeyStore? hostKeys})
    : _hostKeys = hostKeys ?? HostKeyStore();

  static const _sshTimeout = Duration(seconds: 10);

  final HostKeyStore _hostKeys;

  Future<EtSession> connect({
    required ConnectionProfile profile,
    required String password,
    required TrustPrompt trustPrompt,
    int columns = 80,
    int rows = 24,
  }) async {
    final credentials = await _bootstrap(profile, password, trustPrompt);
    return EtSession.connect(
      host: profile.host,
      port: profile.etPort,
      credentials: credentials,
      columns: columns,
      rows: rows,
    );
  }

  Future<EtCredentials> _bootstrap(
    ConnectionProfile profile,
    String password,
    TrustPrompt trustPrompt,
  ) async {
    final socket = await SSHSocket.connect(
      profile.host,
      profile.sshPort,
      timeout: _sshTimeout,
    );
    final client = SSHClient(
      socket,
      username: profile.user,
      onPasswordRequest: () => password,
      onVerifyHostKey: (type, fingerprintBytes) =>
          _verifyHostKey(profile, utf8.decode(fingerprintBytes), trustPrompt),
    );
    try {
      final command = const EtSshBootstrap().command(EtCredentials.random());
      final output = await client.run(command).timeout(_sshTimeout);
      return EtCredentials.parse(utf8.decode(output, allowMalformed: true));
    } finally {
      client.close();
    }
  }

  Future<bool> _verifyHostKey(
    ConnectionProfile profile,
    String fingerprint,
    TrustPrompt trustPrompt,
  ) async {
    final known = await _hostKeys.lookup(profile.host, profile.sshPort);
    if (known != null) {
      if (known == fingerprint) return true;
      throw HostKeyChangedException(known, fingerprint);
    }
    if (!await trustPrompt(fingerprint)) return false;
    await _hostKeys.remember(profile.host, profile.sshPort, fingerprint);
    return true;
  }
}
