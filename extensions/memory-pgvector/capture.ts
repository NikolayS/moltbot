/**
 * Auto-capture detection utilities
 * 
 * Functions to detect whether a message should be captured
 * and what category it belongs to.
 */

import type { MemoryCategory } from "./config.js";

/**
 * Patterns that trigger auto-capture
 */
export const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

/**
 * Determine if text should be auto-captured as a memory
 */
export function shouldCapture(text: string): boolean {
  // Too short or too long
  if (text.length < 10 || text.length > 500) return false;
  
  // Already contains memory context (avoid recursion)
  if (text.includes("<relevant-memories>")) return false;
  
  // Looks like XML/HTML (likely system content)
  if (text.startsWith("<") && text.includes("</")) return false;
  
  // Looks like markdown output (not user input)
  if (text.includes("**") && text.includes("\n-")) return false;
  
  // Too many emoji (probably just reactions)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  
  // Check for trigger patterns
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

/**
 * Detect the category of a memory based on its content
 */
export function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  
  // Preference patterns
  if (/prefer|radši|like|love|hate|want/i.test(lower)) {
    return "preference";
  }
  
  // Decision patterns
  if (/rozhodli|decided|will use|budeme/i.test(lower)) {
    return "decision";
  }
  
  // Entity patterns (phone, email, names)
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
    return "entity";
  }
  
  // Fact patterns
  if (/is|are|has|have|je|má|jsou/i.test(lower)) {
    return "fact";
  }
  
  return "other";
}
