import 'dart:typed_data';

import 'package:pinenacl/digests.dart';
import 'package:pinenacl/tweetnacl.dart';

import '../constants.dart';
import '../exception.dart';

/// One direction of ET's libsodium `crypto_secretbox` stream.
///
/// Port of upstream `CryptoHandler`: the nonce is a 24-byte little-endian
/// counter whose last byte is fixed to a per-direction MSB, and it is
/// incremented *before* every encrypt/decrypt. Output is `MAC || ciphertext`,
/// the layout of `crypto_secretbox_easy`.
class EtCipher {
  /// Creates a cipher for [key] with the direction byte [nonceMsb].
  EtCipher(List<int> key, this.nonceMsb)
    : _baseKey = Uint8List.fromList(key),
      _key = Uint8List.fromList(key) {
    if (key.length != etPasskeyLength) {
      throw const EtException('ET keys must be exactly 32 bytes.');
    }
    _resetNonce();
  }

  /// Direction byte stored in the most significant nonce byte.
  final int nonceMsb;

  final Uint8List _baseKey;
  Uint8List _key;
  final Uint8List _nonce = Uint8List(etNonceLength);

  /// Encrypts [plaintext] with the next nonce.
  Uint8List encrypt(List<int> plaintext) {
    _incrementNonce();
    final padded = Uint8List(TweetNaCl.zerobytesLength + plaintext.length)
      ..setRange(
        TweetNaCl.zerobytesLength,
        TweetNaCl.zerobytesLength + plaintext.length,
        plaintext,
      );
    final out = Uint8List(padded.length);
    return TweetNaCl.crypto_secretbox(out, padded, padded.length, _nonce, _key);
  }

  /// Decrypts `MAC || ciphertext` with the next nonce.
  Uint8List decrypt(List<int> box) {
    if (box.length < etMacLength) {
      throw const EtException('Encrypted ET payload is shorter than its MAC.');
    }
    _incrementNonce();
    final padded = Uint8List(TweetNaCl.boxzerobytesLength + box.length)
      ..setRange(
        TweetNaCl.boxzerobytesLength,
        TweetNaCl.boxzerobytesLength + box.length,
        box,
      );
    final out = Uint8List(padded.length);
    try {
      return TweetNaCl.crypto_secretbox_open(
        out,
        padded,
        padded.length,
        _nonce,
        _key,
      );
    } catch (error) {
      // tweetnacl throws a String on MAC mismatch.
      throw EtException('Decrypt failed. Possible key mismatch?', error);
    }
  }

  /// Derives an epoch key from [salt] and restarts the nonce counter.
  ///
  /// Mirrors `CryptoHandler::rekey`: `key = BLAKE2b-256(salt, key: baseKey)`.
  void rekey(List<int> salt) {
    if (salt.length != etEpochSaltLength) {
      throw const EtException('Invalid epoch salt length.');
    }
    _key = Hash.blake2b(
      Uint8List.fromList(salt),
      digestSize: etGenericHashLength,
      key: _baseKey,
    );
    _resetNonce();
  }

  void _resetNonce() {
    _nonce.fillRange(0, etNonceLength, 0);
    _nonce[etNonceLength - 1] = nonceMsb;
  }

  void _incrementNonce() {
    for (var i = 0; i < etNonceLength; i++) {
      _nonce[i] = (_nonce[i] + 1) & 0xff;
      if (_nonce[i] != 0) break;
    }
  }
}
