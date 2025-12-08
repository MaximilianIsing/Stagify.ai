# API Endpoints Documentation

This document describes all available endpoints in the Stagify.ai server.

## Table of Contents
- [Public Endpoints](#public-endpoints)
- [API Endpoints](#api-endpoints)
- [Protected Log Endpoints](#protected-log-endpoints)

---

## Public Endpoints

### `GET /`
**Description**: Serves the main homepage (index.html)

**Response**: HTML file

---

### `GET /robots.txt`
**Description**: Serves the robots.txt file for search engine crawlers

**Response**: Text file

---

### `GET /sitemap.xml`
**Description**: Serves the sitemap.xml file for search engines

**Response**: XML file

---

## API Endpoints

### `POST /api/process-image`
**Description**: Processes an uploaded image for room staging using AI

**Request**:
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body:
  - `image` (file): Image file to process
  - `roomType` (string, optional): Type of room (default: "Living room")
  - `furnitureStyle` (string, optional): Style of furniture (default: "standard")
  - `additionalPrompt` (string, optional): Additional styling instructions
  - `removeFurniture` (boolean, optional): Whether to remove existing furniture (default: false)
  - `userRole` (string, optional): User's role (default: "unknown")
  - `userReferralSource` (string, optional): Referral source (default: "unknown")
  - `userEmail` (string, optional): User's email (default: "unknown")
  - `model` (string, optional): GPT model to use (default: "gpt-4o-mini")

**Response**:
- Success (200): JSON with processed image data
- Error (400/500): JSON error object

---

### `POST /api/log-contact`
**Description**: Logs contact information to CSV file

**Request**:
- Method: `POST`
- Content-Type: `application/json`
- Body:
  ```json
  {
    "userRole": "string (optional, default: 'unknown')",
    "referralSource": "string (optional, default: 'unknown')",
    "email": "string (optional, default: 'unknown')",
    "userAgent": "string (optional, default: 'unknown')"
  }
  ```

**Response**:
- Success (200): `{ "success": true, "message": "Contact logged successfully" }`
- Error (500): `{ "success": false, "message": "Failed to log contact" }`

---

### `GET /api/health`
**Description**: Health check endpoint

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "ISO timestamp",
  "aiConfigured": true/false
}
```

---

### `GET /api/prompt-count`
**Description**: Returns the current count of processed prompts

**Response**:
```json
{
  "promptCount": 1234
}
```

---

### `GET /api/contact-count`
**Description**: Returns the current count of logged contacts

**Response**:
```json
{
  "contactCount": 567
}
```

---

### `GET /api/welcome-message`
**Description**: Generates a personalized welcome message for users based on their stored memories

**Request**:
- Query Parameters:
  - `userId` (string, optional): User identifier

**Response**:
```json
{
  "message": "Welcome message text",
  "isReturning": true/false
}
```

---

### `POST /api/chat`
**Description**: Main chat endpoint for AI conversations (text-only messages)

**Request**:
- Method: `POST`
- Content-Type: `application/json`
- Body:
  ```json
  {
    "messages": [
      {
        "role": "user" | "assistant",
        "content": "string or array of content objects"
      }
    ],
    "model": "string (optional, default: 'gpt-4o-mini')",
    "messageTag": "string (optional: 'auto' | 'generate' | 'stage' | 'cad-stage' | 'describe')"
  }
  ```

**Response**:
- Success (200): JSON with AI response and any actions (staging, generation, etc.)
- Error (400/500): JSON error object

**Note**: Supports conversation history, memory management, image context, and various AI actions (staging, generation, CAD-staging, image requests, recall).

---

### `POST /api/chat-upload`
**Description**: Chat endpoint for messages with file uploads

**Request**:
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body:
  - `files` (file[]): Array of files (up to 10 files)
  - `message` (string, optional): Text message
  - `conversationHistory` (string, optional): JSON string of conversation history
  - `model` (string, optional): GPT model to use
  - `messageTag` (string, optional): Message tag for context

**Response**:
- Success (200): JSON with AI response and any actions
- Error (400/500): JSON error object

**Supported File Types**: Images (JPEG, JPG, PNG, WebP, GIF), PDFs, text files

---

### `POST /api/bug-report`
**Description**: Submits a bug report

**Request**:
- Method: `POST`
- Content-Type: `application/json`
- Body:
  ```json
  {
    "description": "string (required)",
    "steps": "string (optional)",
    "email": "string (optional)",
    "userId": "string (optional)",
    "userAgent": "string (optional)",
    "url": "string (optional)",
    "timestamp": "string (optional, ISO format)",
    "conversationHistory": "array (optional)"
  }
  ```

**Response**:
- Success (200): `{ "success": true, "message": "Bug report submitted successfully" }`
- Error (400/500): JSON error object

---

## Protected Log Endpoints

All protected endpoints require authentication via query parameter: `?key=YOUR_ACCESS_KEY`

The access key is stored in `endpointkey.txt` (local) or `process.env.endpoint_key` (production).

---

### `GET /promptlogs?key=YOUR_KEY`
**Description**: Retrieves the prompt logs CSV file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): CSV file (`prompt_logs.csv`)
- Error (403): Access denied
- Error (404): File not found

**CSV Columns**: `timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress`

---

### `GET /contactlogs?key=YOUR_KEY`
**Description**: Retrieves the contact logs CSV file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): CSV file (`contact_logs.csv`)
- Error (403): Access denied
- Error (404): File not found

**CSV Columns**: `timestamp,userRole,referralSource,email,userAgent,ipAddress`

---

### `GET /memories?key=YOUR_KEY`
**Description**: Retrieves the memories JSON file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): JSON file (`memories.json`)
- Error (403): Access denied
- Error (404): File not found

**Format**: JSON object with user IDs as keys and arrays of memory objects as values

---

### `GET /resetmemories?key=YOUR_KEY`
**Description**: Resets all memories by emptying the memories JSON file

**Authentication**: Required via `key` query parameter

**Request**: 
- Method: `GET`
- No body required

**Response**:
- Success (200): `{ "success": true, "message": "All memories have been reset successfully" }`
- Error (403): Access denied
- Error (500): Server error

**Note**: This endpoint permanently deletes all stored memories for all users. Use with caution.

---

### `GET /chatlogs?key=YOUR_KEY`
**Description**: Retrieves the chat logs CSV file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): CSV file (`chat_logs.csv`)
- Error (403): Access denied
- Error (404): File not found

**CSV Columns**: `timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent`

---

### `GET /bugreports?key=YOUR_KEY` 
**Description**: Retrieves the bug reports CSV file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): CSV file (`bug_reports.csv`)
- Error (403): Access denied
- Error (404): File not found

**CSV Columns**: `timestamp,description,stepsToReproduce,email,userId,userAgent,url,ipAddress,conversationHistory`

---

### `GET /masklogs?key=YOUR_KEY`
**Description**: Retrieves the mask edit logs CSV file

**Authentication**: Required via `key` query parameter

**Response**:
- Success (200): CSV file (`mask_logs.csv`)
- Error (403): Access denied
- Error (404): File not found

**CSV Columns**: `timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent`

---

## Notes

- All timestamps are in ISO 8601 format
- File uploads use `multipart/form-data` encoding
- Protected endpoints require the access key from `endpointkey.txt` or environment variable
- CSV files are stored in `/data` directory (Render) or `./data` directory (local)
- JSON files (memories) are stored in the same location
- The server supports both local development and Render deployment

---