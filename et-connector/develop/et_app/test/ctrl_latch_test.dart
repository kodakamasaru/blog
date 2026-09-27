import 'package:et_app/terminal/ctrl_latch.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('passes input through when inactive', () {
    expect(CtrlLatch().apply('c'), 'c');
  });

  test('turns a letter into its control character once', () {
    final latch = CtrlLatch()..toggle();
    expect(latch.apply('c'), '\x03');
    expect(latch.isActive, isFalse);
    expect(latch.apply('c'), 'c');
  });

  test('handles upper case, brackets and ?', () {
    expect((CtrlLatch()..toggle()).apply('D'), '\x04');
    expect((CtrlLatch()..toggle()).apply('['), '\x1b');
    expect((CtrlLatch()..toggle()).apply('?'), '\x7f');
  });

  test('leaves characters without a control form unchanged', () {
    expect((CtrlLatch()..toggle()).apply('1'), '1');
  });
}
