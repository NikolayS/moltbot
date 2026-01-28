/**
 * Auto-capture detection tests
 */

import { describe, it, expect } from 'vitest';
import { shouldCapture, detectCategory } from '../capture.js';

describe('shouldCapture', () => {
  it('should return false for short text', () => {
    expect(shouldCapture('hi')).toBe(false);
    expect(shouldCapture('hello')).toBe(false);
  });

  it('should return false for long text', () => {
    const longText = 'x'.repeat(501);
    expect(shouldCapture(longText)).toBe(false);
  });

  it('should return false for memory context', () => {
    expect(shouldCapture('<relevant-memories>some memory</relevant-memories>')).toBe(false);
  });

  it('should return false for XML-like content', () => {
    expect(shouldCapture('<system>You are a helpful assistant</system>')).toBe(false);
  });

  it('should return false for markdown output', () => {
    expect(shouldCapture('**Title**\n- item 1\n- item 2')).toBe(false);
  });

  it('should return false for emoji spam', () => {
    expect(shouldCapture('🎉🎊🎁🎈 party time!')).toBe(false);
  });

  it('should capture preference statements', () => {
    expect(shouldCapture('I prefer dark mode for all my apps')).toBe(true);
    expect(shouldCapture('I like TypeScript more than JavaScript')).toBe(true);
    expect(shouldCapture('I hate when code is not formatted')).toBe(true);
  });

  it('should capture remember requests', () => {
    expect(shouldCapture('Remember that my timezone is PST')).toBe(true);
    expect(shouldCapture('Please remember I use vim keybindings')).toBe(true);
  });

  it('should capture phone numbers', () => {
    expect(shouldCapture('My phone number is +14155551234')).toBe(true);
  });

  it('should capture email addresses', () => {
    expect(shouldCapture('Contact me at test@example.com please')).toBe(true);
  });

  it('should capture decision statements (Czech)', () => {
    // Note: English "decided" is not in MEMORY_TRIGGERS, only Czech patterns
    expect(shouldCapture('Rozhodli jsme se použít PostgreSQL')).toBe(true);
  });

  it('should capture important markers', () => {
    expect(shouldCapture('This is important: always use parameterized queries')).toBe(true);
    expect(shouldCapture('Never store passwords in plain text')).toBe(true);
  });
});

describe('detectCategory', () => {
  it('should detect preferences', () => {
    expect(detectCategory('I prefer dark mode')).toBe('preference');
    expect(detectCategory('I like TypeScript')).toBe('preference');
    expect(detectCategory('I hate slow tests')).toBe('preference');
    expect(detectCategory('I want async/await')).toBe('preference');
  });

  it('should detect decisions', () => {
    expect(detectCategory('We decided to use React')).toBe('decision');
    expect(detectCategory('We will use PostgreSQL')).toBe('decision');
  });

  it('should detect entities', () => {
    expect(detectCategory('My phone is +14155551234')).toBe('entity');
    expect(detectCategory('Email me at test@example.com')).toBe('entity');
    expect(detectCategory('The project is called ClawdBot')).toBe('entity');
  });

  it('should detect facts', () => {
    expect(detectCategory('The server is running on port 5432')).toBe('fact');
    expect(detectCategory('PostgreSQL has JSONB support')).toBe('fact');
  });

  it('should default to other', () => {
    expect(detectCategory('random text here')).toBe('other');
  });
});
