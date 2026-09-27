import 'dart:math';

import 'constants.dart';
import 'exception.dart';

/// Session id and passkey shared between the client and `etterminal`.
class EtCredentials {
  /// Creates credentials after validating their shape.
  EtCredentials({required this.id, required this.passkey}) {
    if (!_isAlphaNumeric(id, etIdLength)) {
      throw const EtException('ET ids must be 16 alphanumeric characters.');
    }
    if (!_isAlphaNumeric(passkey, etPasskeyLength)) {
      throw const EtException(
        'ET passkeys must be 32 alphanumeric characters.',
      );
    }
  }

  /// Generates random credentials, as the upstream client does before SSH.
  ///
  /// The id starts with `XXX` for compatibility with servers that do not
  /// generate their own keys.
  factory EtCredentials.random([Random? random]) {
    final rng = random ?? Random.secure();
    String gen(int length) => String.fromCharCodes(
      List.generate(
        length,
        (_) => _alphabet.codeUnitAt(rng.nextInt(_alphabet.length)),
      ),
    );
    return EtCredentials(
      id: 'XXX${gen(etIdLength - 3)}',
      passkey: gen(etPasskeyLength),
    );
  }

  /// Parses the `IDPASSKEY:<id>/<passkey>` line printed by `etterminal`.
  factory EtCredentials.parse(String output) {
    final match = _pattern.firstMatch(output);
    if (match == null) {
      throw EtException(
        'Could not find an IDPASSKEY line in etterminal output. Make sure the '
        'remote shell rc files print nothing and etserver is running.',
        output,
      );
    }
    return EtCredentials(id: match.group(1)!, passkey: match.group(2)!);
  }

  /// 16-character session id.
  final String id;

  /// 32-character passkey. Its ASCII bytes are the secretbox key.
  final String passkey;

  static final RegExp _pattern = RegExp(
    'IDPASSKEY:([A-Za-z0-9]{$etIdLength})/([A-Za-z0-9]{$etPasskeyLength})(?![A-Za-z0-9])',
  );

  static const String _alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  static bool _isAlphaNumeric(String value, int length) =>
      value.length == length && RegExp(r'^[A-Za-z0-9]+$').hasMatch(value);
}
