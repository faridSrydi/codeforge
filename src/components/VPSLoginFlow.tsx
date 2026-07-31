import React, { useState } from 'react';
import { Box, Text } from '../ink.js';
import { SimpleTextInput } from './SimpleTextInput.js';
import { saveVPSCredentials } from '../utils/vpsAuthStorage.js';

interface Props {
  onDone(): void;
  startingMessage?: string;
}

export function VPSLoginFlow({ onDone, startingMessage }: Props): React.ReactNode {
  const [step, setStep] = useState<'serverUrl' | 'username' | 'password' | 'submitting' | 'error' | 'success'>('serverUrl');
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [resolvedServerUrl, setResolvedServerUrl] = useState('http://localhost:3000');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleServerUrlSubmit = (value: string) => {
    const trimmed = value.trim();
    const finalUrl = trimmed || 'http://localhost:3000';
    setResolvedServerUrl(finalUrl);
    setStep('username');
  };

  const handleUsernameSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setUsername(trimmed);
    setStep('password');
  };

  const handlePasswordSubmit = async (value: string) => {
    if (!value) return;
    setPassword(value);
    setStep('submitting');
    setErrorMessage('');

    try {
      const baseUrl = resolvedServerUrl.replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: value })
      });

      const data = await response.json() as any;

      if (!response.ok) {
        setErrorMessage(data.error?.message || 'Login failed. Invalid username or password.');
        setStep('error');
        return;
      }

      if (!data.token) {
        setErrorMessage('Server did not return a valid authentication token.');
        setStep('error');
        return;
      }

      // Save credentials to ~/.codeforge/credentials.json
      saveVPSCredentials({
        serverUrl: baseUrl,
        username: data.user?.username || username,
        token: data.token
      });

      setStep('success');
      setTimeout(() => {
        onDone();
      }, 800);

    } catch (err: any) {
      setErrorMessage(`Network error: ${err.message || 'Could not connect to VPS server.'}`);
      setStep('error');
    }
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="yellow">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⚡ CodeForge Private AI Server Login
        </Text>
      </Box>

      {startingMessage && (
        <Box marginBottom={1}>
          <Text dimColor>{startingMessage}</Text>
        </Box>
      )}

      {step === 'serverUrl' && (
        <Box flexDirection="column">
          <Text bold>Server URL <Text dimColor>(Press Enter for default: http://localhost:3000)</Text>:</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <SimpleTextInput
              value={serverUrlInput}
              onChange={setServerUrlInput}
              onSubmit={handleServerUrlSubmit}
              placeholder="http://localhost:3000"
            />
          </Box>
        </Box>
      )}

      {step === 'username' && (
        <Box flexDirection="column">
          <Text dimColor>Server: {resolvedServerUrl}</Text>
          <Box marginTop={1}>
            <Text bold>Username:</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <SimpleTextInput
              value={username}
              onChange={setUsername}
              onSubmit={handleUsernameSubmit}
              placeholder="Enter username"
            />
          </Box>
        </Box>
      )}

      {step === 'password' && (
        <Box flexDirection="column">
          <Text dimColor>Server: {resolvedServerUrl}</Text>
          <Text dimColor>User: @{username}</Text>
          <Box marginTop={1}>
            <Text bold>Password:</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <SimpleTextInput
              value={password}
              onChange={setPassword}
              onSubmit={handlePasswordSubmit}
              mask="*"
              placeholder="Enter password"
            />
          </Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box marginTop={1}>
          <Text color="yellow">⏳ Connecting to VPS server...</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>❌ {errorMessage}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to try again...</Text>
          </Box>
          <SimpleTextInput
            value=""
            onChange={() => {}}
            onSubmit={() => setStep('serverUrl')}
          />
        </Box>
      )}

      {step === 'success' && (
        <Box marginTop={1}>
          <Text color="green" bold>
            ✅ Authentication successful! Welcome, @{username}.
          </Text>
        </Box>
      )}
    </Box>
  );
}
