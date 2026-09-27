/// One-shot Ctrl modifier for the on-screen toolbar.
///
/// iOS soft keyboards have no Ctrl key: tap Ctrl, then a letter, and the
/// letter is sent as a control character (Ctrl+C → 0x03).
class CtrlLatch {
  bool _active = false;

  bool get isActive => _active;

  void toggle() => _active = !_active;

  /// Converts [input] if the latch is active, then releases it.
  String apply(String input) {
    if (!_active || input.isEmpty) return input;
    _active = false;
    final code = input.codeUnitAt(0);
    final upper = code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
    // '@'..'_' map to 0x00..0x1f; '?' is DEL.
    if (upper >= 0x40 && upper <= 0x5f) {
      return String.fromCharCode(upper & 0x1f) + input.substring(1);
    }
    if (upper == 0x3f) return '\x7f${input.substring(1)}';
    return input;
  }
}
