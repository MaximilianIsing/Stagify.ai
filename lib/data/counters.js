// Runtime counters (rooms staged / contact submissions) shown on the home page.
//
// The counters are written from the staging + chat flows and read from the
// public stats endpoint. Keeping the mutable state here — with the accessors —
// makes this module the single owner: every importer shares the same live value
// rather than a snapshot. Increment uses `+= 1` (not `++`) so a global
// "++" -> "inc" rewrite of a caller can never make an accessor self-recurse.
// Extracted verbatim from server.js.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEBUG_MODE } from '../config/runtime-flags.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // two levels up: lib/data/ -> repo root

let promptCount = 0;
let contactCount = 0;

export function getPromptCount() { return promptCount; }
export function incPromptCount() { promptCount += 1; }
export function getContactCount() { return contactCount; }
export function incContactCount() { contactCount += 1; }

// Initialize prompt count from CSV file
export function initializePromptCount() {
  try {
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(rootDir, 'data');
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');

    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');

      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      promptCount = matches ? matches.length : 0;
      if (DEBUG_MODE) {
        console.log('Prompt count successfully initialized from file:', promptCount);
      }
    } else {
      if (DEBUG_MODE) {
        console.log('No prompt log file found, starting with count 0');
      }
      promptCount = 0;
    }
  } catch (error) {
    console.error('Error initializing prompt count:', error);
    promptCount = 0;
  }
}

// Initialize contact count from CSV file
export function initializeContactCount() {
  try {
    let logDir;

    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(rootDir, 'data');
    }

    const logFile = path.join(logDir, 'contact_logs.csv');

    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');

      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      contactCount = matches ? matches.length : 0;
      if (DEBUG_MODE) {
        console.log('Contact count successfully initialized from file:', contactCount);
      }
    } else {
      if (DEBUG_MODE) {
        console.log('No contact log file found, starting with count 0');
      }
      contactCount = 0;
    }
  } catch (error) {
    console.error('Error initializing contact count:', error);
    contactCount = 0;
  }
}
