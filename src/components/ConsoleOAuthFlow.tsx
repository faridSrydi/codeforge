import React from 'react';
import { VPSLoginFlow } from './VPSLoginFlow.js';

type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
};

export function ConsoleOAuthFlow({
  onDone,
  startingMessage
}: Props): React.ReactNode {
  return <VPSLoginFlow onDone={onDone} startingMessage={startingMessage} />;
}