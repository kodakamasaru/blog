import 'package:dart_et/dart_et.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where and how to connect. The password is never stored.
class ConnectionProfile {
  const ConnectionProfile({
    required this.host,
    required this.user,
    this.sshPort = 22,
    this.etPort = etDefaultPort,
  });

  static const empty = ConnectionProfile(host: '', user: '');

  final String host;
  final String user;
  final int sshPort;
  final int etPort;

  ConnectionProfile copyWith({
    String? host,
    String? user,
    int? sshPort,
    int? etPort,
  }) => ConnectionProfile(
    host: host ?? this.host,
    user: user ?? this.user,
    sshPort: sshPort ?? this.sshPort,
    etPort: etPort ?? this.etPort,
  );

  static const _prefix = 'profile.';

  static Future<ConnectionProfile> load() async {
    final prefs = await SharedPreferences.getInstance();
    return ConnectionProfile(
      host: prefs.getString('${_prefix}host') ?? '',
      user: prefs.getString('${_prefix}user') ?? '',
      sshPort: prefs.getInt('${_prefix}sshPort') ?? 22,
      etPort: prefs.getInt('${_prefix}etPort') ?? etDefaultPort,
    );
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('${_prefix}host', host);
    await prefs.setString('${_prefix}user', user);
    await prefs.setInt('${_prefix}sshPort', sshPort);
    await prefs.setInt('${_prefix}etPort', etPort);
  }
}
