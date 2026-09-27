// Minimal protobuf wire-format codec.
//
// Adapted from dart_mosh (lib/src/protocol/protobuf.dart, Apache-2.0,
// https://github.com/gwitko/dart_mosh): added bool/string/int32 helpers and
// signed int32 decoding so ET's proto2 messages can be handled without protoc.
import 'dart:convert';
import 'dart:typed_data';

import '../exception.dart';

class ProtoField {
  const ProtoField(this.number, this.wireType);

  final int number;
  final int wireType;
}

class ProtoWriter {
  final BytesBuilder _bytes = BytesBuilder(copy: false);

  void int32(int field, int value) {
    _tag(field, wireTypeVarint);
    // Negative int32 values are sign-extended to 64 bits (10-byte varint).
    _varint(value < 0 ? value.toUnsigned(64) : value);
  }

  void boolean(int field, bool value) => int32(field, value ? 1 : 0);

  void bytes(int field, List<int> value) {
    _tag(field, wireTypeLengthDelimited);
    _varint(value.length);
    _bytes.add(value);
  }

  void string(int field, String value) => bytes(field, utf8.encode(value));

  Uint8List takeBytes() => _bytes.takeBytes();

  void _tag(int field, int wireType) =>
      _varint((field << _wireTypeBits) | wireType);

  void _varint(int value) {
    // Dart ints are 64-bit two's complement; use unsigned shifts so that
    // sign-extended values terminate after 10 bytes.
    var remaining = value;
    while (remaining < 0 || remaining >= _varintContinuationBit) {
      _bytes.addByte((remaining & _varintPayloadMask) | _varintContinuationBit);
      remaining = remaining >>> _varintPayloadBits;
    }
    _bytes.addByte(remaining);
  }
}

class ProtoReader {
  ProtoReader(List<int> bytes) : _bytes = Uint8List.fromList(bytes);

  final Uint8List _bytes;
  var _offset = 0;

  bool get isDone => _offset >= _bytes.length;

  ProtoField nextField() {
    final tag = readVarint();
    return ProtoField(tag >> _wireTypeBits, tag & _wireTypeMask);
  }

  int readVarint() {
    var shift = 0;
    var result = 0;
    while (shift < _maxVarintBits) {
      if (_offset >= _bytes.length) {
        throw const EtException('Unexpected end of protobuf varint.');
      }
      final byte = _bytes[_offset++];
      result |= (byte & _varintPayloadMask) << shift;
      if ((byte & _varintContinuationBit) == 0) return result;
      shift += _varintPayloadBits;
    }
    throw const EtException('Protobuf varint is too long.');
  }

  int readInt32() => readVarint().toSigned(32);

  bool readBool() => readVarint() != 0;

  Uint8List readBytes() {
    final length = readVarint();
    if (length < 0 || _offset + length > _bytes.length) {
      throw const EtException('Unexpected end of protobuf bytes field.');
    }
    final value = _bytes.sublist(_offset, _offset + length);
    _offset += length;
    return value;
  }

  String readString() => utf8.decode(readBytes(), allowMalformed: true);

  void skip(int wireType) {
    switch (wireType) {
      case wireTypeVarint:
        readVarint();
      case _wireTypeFixed64:
        _skipBytes(_fixed64Length);
      case wireTypeLengthDelimited:
        _skipBytes(readVarint());
      case _wireTypeFixed32:
        _skipBytes(_fixed32Length);
      default:
        throw EtException('Unsupported protobuf wire type: $wireType.');
    }
  }

  void _skipBytes(int length) {
    if (length < 0 || _offset + length > _bytes.length) {
      throw const EtException('Unexpected end of protobuf field.');
    }
    _offset += length;
  }
}

const int wireTypeVarint = 0;
const int _wireTypeFixed64 = 1;
const int wireTypeLengthDelimited = 2;
const int _wireTypeFixed32 = 5;
const int _wireTypeBits = 3;
const int _wireTypeMask = 0x7;
const int _varintPayloadBits = 7;
const int _varintPayloadMask = 0x7f;
const int _varintContinuationBit = 0x80;
const int _maxVarintBits = 70;
const int _fixed32Length = 4;
const int _fixed64Length = 8;
