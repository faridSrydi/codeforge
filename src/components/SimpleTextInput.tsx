import React, { useState, useEffect } from 'react';
import { Text, useInput } from '../ink.js';

interface Props {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  placeholder?: string;
  mask?: string;
}

export function SimpleTextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  mask = ''
}: Props) {
  const [cursorPos, setCursorPos] = useState(value.length);

  // Sync cursor position when value is cleared externally
  useEffect(() => {
    if (cursorPos > value.length) {
      setCursorPos(value.length);
    }
  }, [value]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.leftArrow) {
      setCursorPos(p => Math.max(0, p - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorPos(p => Math.min(value.length, p + 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        const newValue = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
        onChange(newValue);
        setCursorPos(p => Math.max(0, p - 1));
      }
      return;
    }

    // Standard character input (exclude control characters)
    if (input && !key.ctrl && !key.meta && !key.tab) {
      const newValue = value.slice(0, cursorPos) + input + value.slice(cursorPos);
      onChange(newValue);
      setCursorPos(p => p + input.length);
    }
  });

  const displayValue = mask ? mask.repeat(value.length) : value;

  if (!displayValue && placeholder) {
    return (
      <Text>
        <Text inverse>{' '}</Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }

  const beforeCursor = displayValue.slice(0, cursorPos);
  const atCursor = displayValue.slice(cursorPos, cursorPos + 1) || ' ';
  const afterCursor = displayValue.slice(cursorPos + 1);

  return (
    <Text>
      {beforeCursor}
      <Text inverse>{atCursor}</Text>
      {afterCursor}
    </Text>
  );
}
