import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { captureError } from '@/lib/reporting';
import { Palette, Spacing, Typography } from '@/constants/theme';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Root error boundary — catches render/runtime errors so the app shows a recovery screen instead
 * of a blank crash, and reports them via `captureError`. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    captureError(error, { boundary: 'root' });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <View style={styles.root}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>The app hit an unexpected error. You can try again.</Text>
          <Button label="Try again" onPress={this.reset} />
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Palette.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.seven,
    gap: Spacing.four,
  },
  title: { ...Typography.title, color: Palette.white },
  subtitle: { ...Typography.caption, color: Palette.textSecondary, textAlign: 'center' },
});
