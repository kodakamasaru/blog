import 'package:shared_preferences/shared_preferences.dart';

/// Trust-on-first-use store for SSH host key fingerprints.
class HostKeyStore {
  static String _key(String host, int port) => 'hostkey.$host:$port';

  Future<String?> lookup(String host, int port) async =>
      (await SharedPreferences.getInstance()).getString(_key(host, port));

  Future<void> remember(String host, int port, String fingerprint) async =>
      (await SharedPreferences.getInstance()).setString(
        _key(host, port),
        fingerprint,
      );
}
