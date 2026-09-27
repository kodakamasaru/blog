import 'dart:async';
import 'dart:convert';

import 'package:dart_et/dart_et.dart';
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import 'ctrl_latch.dart';
import 'key_toolbar.dart';

/// ET セッションを xterm で表示する画面。
class TerminalScreen extends StatefulWidget {
  const TerminalScreen({super.key, required this.session, required this.title});

  final EtSession session;
  final String title;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen>
    with WidgetsBindingObserver {
  final _terminal = Terminal(maxLines: 10000);
  final _ctrl = CtrlLatch();
  late final StreamSubscription<String> _output;
  var _ended = false;

  EtSession get _session => widget.session;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Multi-byte UTF-8 can be split across TERMINAL_BUFFER packets.
    _output = _session.stdout
        .transform(const Utf8Decoder(allowMalformed: true))
        .listen(_terminal.write);
    _terminal.onOutput = (data) {
      if (_ended) return;
      final input = _ctrl.apply(data);
      setState(() {}); // Ctrl のハイライトを戻す
      _session.send(utf8.encode(input));
    };
    _terminal.onResize = (columns, rows, _, _) {
      if (!_ended) _session.resize(columns, rows);
    };
    _session.done.then((_) {
      if (mounted) setState(() => _ended = true);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // iOS はバックグラウンドで TCP を止める。復帰したら死んだソケットを待たずに張り直す。
    if (state == AppLifecycleState.resumed && !_ended) {
      _session.reconnect();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_output.cancel());
    unawaited(_session.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: TerminalThemes.defaultTheme.background,
      appBar: AppBar(
        title: Text(widget.title, style: const TextStyle(fontSize: 15)),
        actions: [_StatusChip(session: _session, ended: _ended)],
      ),
      body: Column(
        children: [
          Expanded(
            child: TerminalView(
              _terminal,
              autofocus: true,
              // iOS のソフトキーボードは空欄でのバックスペースを通知しないので、
              // xterm 側で番兵文字を置いて削除を検出させる。
              deleteDetection: true,
              padding: const EdgeInsets.all(4),
              textStyle: const TerminalStyle(fontSize: 13, fontFamily: 'Menlo'),
              readOnly: _ended,
            ),
          ),
          if (!_ended) KeyToolbar(terminal: _terminal, ctrl: _ctrl),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.session, required this.ended});

  final EtSession session;
  final bool ended;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<EtConnectionState>(
      stream: session.states,
      initialData: session.state,
      builder: (context, snapshot) {
        final (label, color) = switch ((ended, snapshot.data)) {
          (true, _) => ('終了', const Color(0xFF8A8F98)),
          (_, EtConnectionState.reconnecting) => (
            '再接続中…',
            const Color(0xFFE8B04B),
          ),
          (_, EtConnectionState.closed) => ('終了', const Color(0xFF8A8F98)),
          _ => ('ET 接続中', const Color(0xFF5CC98B)),
        };
        return Padding(
          padding: const EdgeInsets.only(right: 12),
          child: Row(
            children: [
              Icon(Icons.circle, size: 9, color: color),
              const SizedBox(width: 6),
              Text(label, style: TextStyle(fontSize: 13, color: color)),
            ],
          ),
        );
      },
    );
  }
}
