import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import 'ctrl_latch.dart';

/// Keys the iOS keyboard lacks: Esc, Tab, Ctrl, arrows, and a few symbols.
class KeyToolbar extends StatefulWidget {
  const KeyToolbar({super.key, required this.terminal, required this.ctrl});

  final Terminal terminal;
  final CtrlLatch ctrl;

  @override
  State<KeyToolbar> createState() => _KeyToolbarState();
}

class _KeyToolbarState extends State<KeyToolbar> {
  void _key(TerminalKey key) => widget.terminal.keyInput(key);

  void _text(String text) => widget.terminal.textInput(text);

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    // Bracketed paste keeps the shell from running each pasted line at once.
    if (text != null && text.isNotEmpty) widget.terminal.paste(text);
  }

  @override
  Widget build(BuildContext context) {
    final keys = <Widget>[
      _ToolbarKey(label: 'paste', onTap: _paste),
      _ToolbarKey(label: 'esc', onTap: () => _key(TerminalKey.escape)),
      _ToolbarKey(label: 'tab', onTap: () => _key(TerminalKey.tab)),
      _ToolbarKey(
        label: 'ctrl',
        active: widget.ctrl.isActive,
        onTap: () => setState(widget.ctrl.toggle),
      ),
      _ToolbarKey(label: '←', onTap: () => _key(TerminalKey.arrowLeft)),
      _ToolbarKey(label: '↓', onTap: () => _key(TerminalKey.arrowDown)),
      _ToolbarKey(label: '↑', onTap: () => _key(TerminalKey.arrowUp)),
      _ToolbarKey(label: '→', onTap: () => _key(TerminalKey.arrowRight)),
      for (final symbol in const ['|', '~', '/', '-', '`'])
        _ToolbarKey(label: symbol, onTap: () => _text(symbol)),
    ];
    return Material(
      color: const Color(0xFF16181D),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            children: keys,
          ),
        ),
      ),
    );
  }
}

class _ToolbarKey extends StatelessWidget {
  const _ToolbarKey({
    required this.label,
    required this.onTap,
    this.active = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Material(
        color: active ? const Color(0xFFE8B04B) : const Color(0xFF2A2E37),
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minWidth: 40),
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              label,
              style: TextStyle(
                fontFamily: 'Menlo',
                fontSize: 14,
                color: active
                    ? const Color(0xFF16181D)
                    : const Color(0xFFD7DAE0),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
