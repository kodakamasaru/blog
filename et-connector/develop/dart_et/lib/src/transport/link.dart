import 'dart:async';
import 'dart:io';

import 'byte_queue.dart';

/// Opens a TCP socket to an etserver.
typedef EtSocketConnector =
    Future<Socket> Function(String host, int port, Duration timeout);

/// Default connector: plain TCP with Nagle disabled.
Future<Socket> defaultEtSocketConnector(
  String host,
  int port,
  Duration timeout,
) async {
  final socket = await Socket.connect(host, port, timeout: timeout);
  socket.setOption(SocketOption.tcpNoDelay, true);
  return socket;
}

/// One TCP connection plus its read buffer.
///
/// Read and write errors both end up closing [queue], so a single pending
/// `take()` is enough to notice that the link died.
class EtLink {
  EtLink(this.socket) {
    _subscription = socket.listen(
      queue.add,
      onError: (Object error) =>
          queue.close(EtLinkClosedException('Socket read error.', error)),
      onDone: queue.close,
      cancelOnError: true,
    );
    socket.done.then(
      (_) {},
      onError: (Object error) =>
          queue.close(EtLinkClosedException('Socket write error.', error)),
    );
  }

  final Socket socket;
  final ByteQueue queue = ByteQueue();
  late final StreamSubscription<List<int>> _subscription;
  var _destroyed = false;

  bool get isDestroyed => _destroyed;

  /// Writes raw bytes unless the link is already gone.
  void add(List<int> bytes) {
    if (_destroyed) return;
    try {
      socket.add(bytes);
    } on StateError catch (error) {
      queue.close(EtLinkClosedException('Socket is closed.', error));
    }
  }

  /// Tries to send buffered bytes and close gracefully.
  Future<void> closeGracefully(Duration timeout) async {
    if (_destroyed) return;
    try {
      await socket.flush().timeout(timeout);
      await socket.close().timeout(timeout);
    } catch (_) {
      // Best effort: the link is being torn down anyway.
    }
    destroy();
  }

  /// Tears the link down immediately.
  void destroy() {
    if (_destroyed) return;
    _destroyed = true;
    unawaited(_subscription.cancel());
    socket.destroy();
    queue.close();
  }
}
