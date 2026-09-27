/// Exception thrown when ET parsing, framing, cryptography, or handshakes fail.
class EtException implements Exception {
  /// Creates an ET exception with a human-readable [message].
  const EtException(this.message, [this.cause]);

  /// Human-readable error message.
  final String message;

  /// Optional underlying error or rejected input.
  final Object? cause;

  @override
  String toString() {
    final cause = this.cause;
    return cause == null
        ? 'EtException: $message'
        : 'EtException: $message ($cause)';
  }
}

/// Thrown when the server no longer knows the session (the remote shell ended).
class EtSessionEndedException extends EtException {
  /// Creates a session-ended exception.
  const EtSessionEndedException([super.message = 'The ET session has ended.']);
}

/// Thrown when the peer's sequence number cannot be served from the backup.
class EtRecoveryException extends EtException {
  /// Creates a recovery exception.
  const EtRecoveryException(super.message);
}
