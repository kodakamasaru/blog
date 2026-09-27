import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import '../exception.dart';

/// Buffers socket chunks and hands out exact-length reads.
///
/// ET's framing is "read N bytes, then M bytes", which is awkward with a
/// chunked `Stream<Uint8List>`; this turns it back into `await take(n)`.
class ByteQueue {
  final _chunks = ListQueue<Uint8List>();
  var _available = 0;
  var _headOffset = 0;
  Completer<Uint8List>? _waiter;
  var _wanted = 0;
  Object? _closeError;
  var _closed = false;

  /// Bytes currently buffered.
  int get available => _available;

  /// Appends a chunk received from the socket.
  void add(Uint8List chunk) {
    if (_closed || chunk.isEmpty) return;
    _chunks.add(chunk);
    _available += chunk.length;
    _satisfy();
  }

  /// Marks the stream finished; pending and future reads fail.
  void close([Object? error]) {
    if (_closed) return;
    _closed = true;
    _closeError = error;
    final waiter = _waiter;
    _waiter = null;
    waiter?.completeError(_endError());
  }

  /// Reads exactly [count] bytes.
  Future<Uint8List> take(int count) {
    if (_waiter != null) {
      throw StateError('Only one pending take() is allowed.');
    }
    if (count <= _available) return Future.value(_read(count));
    if (_closed) return Future.error(_endError());
    _wanted = count;
    final waiter = Completer<Uint8List>();
    _waiter = waiter;
    return waiter.future;
  }

  void _satisfy() {
    final waiter = _waiter;
    if (waiter == null || _available < _wanted) return;
    _waiter = null;
    waiter.complete(_read(_wanted));
  }

  Uint8List _read(int count) {
    final out = Uint8List(count);
    var written = 0;
    while (written < count) {
      final head = _chunks.first;
      final n = (head.length - _headOffset).clamp(0, count - written);
      out.setRange(written, written + n, head, _headOffset);
      written += n;
      _headOffset += n;
      if (_headOffset == head.length) {
        _chunks.removeFirst();
        _headOffset = 0;
      }
    }
    _available -= count;
    return out;
  }

  Object _endError() =>
      _closeError ?? const EtLinkClosedException('Connection closed by peer.');
}

/// The TCP link underneath a session went away; the session can be resumed.
class EtLinkClosedException extends EtException {
  /// Creates a link-closed exception.
  const EtLinkClosedException(super.message, [super.cause]);
}
