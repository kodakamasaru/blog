import 'package:flutter/material.dart';

import '../terminal/terminal_screen.dart';
import 'connection_profile.dart';
import 'et_connector.dart';

/// 接続先を入力する画面。
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, this.connector});

  final EtConnector? connector;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _formKey = GlobalKey<FormState>();
  final _host = TextEditingController();
  final _user = TextEditingController();
  final _password = TextEditingController();
  final _sshPort = TextEditingController(text: '22');
  final _etPort = TextEditingController(text: '2022');
  late final EtConnector _connector = widget.connector ?? EtConnector();
  var _connecting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    ConnectionProfile.load().then((profile) {
      if (!mounted) return;
      _host.text = profile.host;
      _user.text = profile.user;
      _sshPort.text = '${profile.sshPort}';
      _etPort.text = '${profile.etPort}';
    });
  }

  @override
  void dispose() {
    for (final c in [_host, _user, _password, _sshPort, _etPort]) {
      c.dispose();
    }
    super.dispose();
  }

  ConnectionProfile get _profile => ConnectionProfile(
    host: _host.text.trim(),
    user: _user.text.trim(),
    sshPort: int.parse(_sshPort.text),
    etPort: int.parse(_etPort.text),
  );

  Future<void> _connect() async {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _connecting = true;
      _error = null;
    });
    final profile = _profile;
    try {
      final session = await _connector.connect(
        profile: profile,
        password: _password.text,
        trustPrompt: _askTrust,
      );
      await profile.save();
      if (!mounted) {
        await session.close();
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TerminalScreen(
            session: session,
            title: '${profile.user}@${profile.host}',
          ),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<bool> _askTrust(String keyType, String fingerprint) async {
    final trusted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('初めて接続するホストです'),
        content: SelectableText(
          'ホスト鍵（${_keyLabel(keyType)}）のフィンガープリント:\n\n'
          '$fingerprint\n\n'
          'Mac で次を実行し、${_keyLabel(keyType)} の行と一致するか確認してください。\n\n'
          'ssh-keyscan localhost | ssh-keygen -lf -',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('やめる'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('信頼する'),
          ),
        ],
      ),
    );
    return trusted ?? false;
  }

  /// `ssh-keygen -l` の表記（ED25519 / ECDSA / RSA）に合わせる。
  static String _keyLabel(String keyType) => switch (keyType) {
    'ssh-ed25519' => 'ED25519',
    'ssh-rsa' || 'rsa-sha2-256' || 'rsa-sha2-512' => 'RSA',
    _ when keyType.startsWith('ecdsa-') => 'ECDSA',
    _ => keyType,
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
            children: [
              Text(
                'et',
                style: Theme.of(context).textTheme.displayMedium?.copyWith(
                  fontFamily: 'Menlo',
                  fontWeight: FontWeight.w700,
                  color: const Color(0xFFE8B04B),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Eternal Terminal client in pure Dart',
                style: Theme.of(context).textTheme.bodyMedium
                    ?.copyWith(color: const Color(0xFF8A8F98)),
              ),
              const SizedBox(height: 36),
              _field(
                _host,
                'ホスト',
                hint: 'my-mac.local / 100.x.y.z',
                keyboard: TextInputType.url,
              ),
              _field(_user, 'ユーザー名'),
              _field(
                _password,
                'パスワード（SSH 用・保存しません）',
                obscure: true,
                required: false,
              ),
              Row(
                children: [
                  Expanded(child: _field(_sshPort, 'SSH ポート', port: true)),
                  const SizedBox(width: 12),
                  Expanded(child: _field(_etPort, 'ET ポート', port: true)),
                ],
              ),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _connecting ? null : _connect,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(52),
                  backgroundColor: const Color(0xFFE8B04B),
                  foregroundColor: const Color(0xFF16181D),
                ),
                child: _connecting
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('接続', style: TextStyle(fontSize: 16)),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                SelectableText(
                  _error!,
                  style: const TextStyle(color: Color(0xFFF07178)),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    String? hint,
    bool obscure = false,
    bool port = false,
    bool required = true,
    TextInputType? keyboard,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextFormField(
        controller: controller,
        obscureText: obscure,
        autocorrect: false,
        enableSuggestions: false,
        textCapitalization: TextCapitalization.none,
        keyboardType: port ? TextInputType.number : keyboard,
        decoration: InputDecoration(labelText: label, hintText: hint),
        validator: (value) {
          final text = value?.trim() ?? '';
          if (required && text.isEmpty) return '入力してください';
          if (port) {
            final n = int.tryParse(text);
            if (n == null || n < 1 || n > 65535) return '1〜65535';
          }
          return null;
        },
      ),
    );
  }
}
