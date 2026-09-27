import 'package:et_app/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('shows validation errors for an empty form', (tester) async {
    await tester.pumpWidget(const EtApp());
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '接続'));
    await tester.pump();
    expect(find.text('入力してください'), findsNWidgets(2));
  });

  testWidgets('restores the last profile', (tester) async {
    SharedPreferences.setMockInitialValues({
      'profile.host': 'my-mac.local',
      'profile.user': 'masaru',
    });
    await tester.pumpWidget(const EtApp());
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextFormField, 'my-mac.local'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'masaru'), findsOneWidget);
  });
}
