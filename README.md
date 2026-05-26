# PlateWise AI

PlateWise AI is a full-stack food health and nutrition assistant. Users can create a dietary profile, upload or capture meal photos, analyse meals with AI, edit detected ingredients, generate structured nutrition reports, and review historical meal records.

> This system provides general nutrition support only. It is not a medical diagnosis tool and should not replace professional medical advice.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Local Development](#local-development)
- [Cloud Deployment](#cloud-deployment)
- [Backend API](#backend-api)
- [Supabase Setup](#supabase-setup)
- [Data Files](#data-files)
- [Troubleshooting](#troubleshooting)
- [Client Handover](#client-handover)

## Overview

PlateWise AI uses a separated frontend and backend architecture.

```text
User Browser
  -> Frontend Web App
  -> Supabase Auth / Database / Storage
  -> FastAPI NLP Backend
  -> Gemini API + local NLP modules
```

Local service URLs:

```text
Frontend: http://127.0.0.1:5500/index.html
NLP API:  http://127.0.0.1:9000
```

Cloud deployment targets:

```text
Frontend: GitHub Pages
Backend:  Render Web Service / Vercel Web Service
Database: Supabase
Storage:  Supabase Storage
Auth:     Supabase Auth
```

## Features

- Supabase-based sign-up, login, email confirmation, and onboarding
- Personal profile management for goals, activity level, restrictions, health conditions, and avatar
- Meal image upload or camera capture with AI-based food recognition
- Editable ingredients with food search, custom items, and portion adjustment
- Profile-aware nutrition advice through chat and meal analysis
- Structured report generation with calories, macros, sodium, sugar, fiber, risk level, and recommendations
- Saved report history, search, filtering, meal detail view, and dashboard summaries

## Tech Stack

| Area | Technologies |
| --- | --- |
| Frontend | HTML, CSS, JavaScript ES modules, Supabase JavaScript client |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic, Pillow, Pandas |
| Database and Storage | Supabase Auth, Supabase PostgreSQL, Supabase Storage, Row Level Security policies |
| Data | USDA-style CSV data, local food database, JSON reference libraries |
| AI and Nutrition APIs | Gemini API, local NLP modules |

## Project Structure

```text
.
|-- frontend/
|   |-- index.html
|   |-- confirm.html
|   |-- onboarding.html
|   |-- dashboard.html
|   |-- chat.html
|   |-- history.html
|   |-- meal-detail.html
|   |-- profile.html
|   |-- style.css
|   |-- assets/
|   `-- js/
|-- nlp/
|   |-- nlp_api.py
|   |-- platewise_streamlit_app.py
|   |-- requirements.txt
|   |-- .env.example
|   |-- food_database.csv
|   |-- usda_LLMprompt.csv
|   |-- nutrition5k_food_entity_library.json
|   |-- disease_library.json
|   `-- who_knowledge.json
|-- supabase/
|   `-- rls_policies.sql
|-- docs/
|   `-- PROJECT_HANDOVER_DETAILS.md
|-- .github/workflows/
|-- setup.ps1
|-- start-backend.ps1
|-- start-frontend.ps1
|-- PlateAI.pdf
|-- .gitignore
`-- README.md
```

## Configuration

### Frontend

Frontend Supabase configuration is stored in:

```text
frontend/js/config.js
```

```js
export const APP_CONFIG = {
  APP_NAME: "PlateWise AI",
  SUPABASE_URL: "your_supabase_project_url",
  SUPABASE_PUBLISHABLE_KEY: "your_supabase_publishable_key",
  DEFAULT_AVATAR: "P",
};
```

The Supabase publishable key can be used in browser code only when Row Level Security is correctly configured.

### Backend

The backend reads environment variables from:

```text
nlp/.env
```

This file is not committed to Git because it contains secrets. A safe template is committed at:

```text
nlp/.env.example
```

Required variables:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite
```

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API access |
| `GEMINI_MODEL` | Gemini model name used by the backend |

### Backend URL Used by Frontend

The frontend backend URL logic is in:

```text
frontend/js/pages/chatPage.js
```

Local development uses:

```text
http://127.0.0.1:9000
```

Production fallback:

```js
window.PLATEWISE_NLP_BASE ||
localStorage.getItem("PLATEWISE_NLP_BASE") ||
"https://YOUR_RENDER_NLP_URL.onrender.com"
```

Before production handover, replace the placeholder backend URL or set `PLATEWISE_NLP_BASE`.


## Local Development

Use this path when cloning the repository for active frontend/backend development.

### Requirements

```text
Python 3.12
Supabase project
Gemini API key
```

### 1. Clone the Repository

```powershell
git clone https://github.sydney.edu.au/yhan9755/Capstone_project_CS66-1.git
cd Capstone_project_CS66-1
```

### 2. Create Backend Environment

```powershell
cd nlp
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
```

### 3. Create `.env`

```powershell
copy .env.example .env
notepad .env
```

Paste your own Gemini API key:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite
```

### 4. Start the Backend

Keep this PowerShell window in the `nlp` folder:

```powershell
py -3.12 -m uvicorn nlp_api:app --host 127.0.0.1 --port 9000
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:9000/
```

Food search check:

```powershell
Invoke-RestMethod "http://127.0.0.1:9000/food-search?q=rice&limit=5"
```

### 5. Start the Frontend

Open another PowerShell window from the repository root:

```powershell
cd frontend
py -3.12 -m http.server 5500
```

Frontend URL:

```text
http://127.0.0.1:5500/index.html
```

## Cloud Deployment

### Frontend: GitHub Pages

Workflow:

```text
.github/workflows/deploy-frontend.yml
```

The workflow deploys the `frontend/` folder when changes are pushed to `main`.

Check deployment status:

```text
GitHub -> Actions
```

Expected frontend URL format:

```text
https://your-username.github.io/your-repository/
```

### Backend: Render

Suggested Render settings:

```text
Root Directory: nlp
Build Command: pip install -r requirements.txt
Start Command: uvicorn nlp_api:app --host 0.0.0.0 --port $PORT
```

Required Render environment variables:

```text
GEMINI_API_KEY
GEMINI_MODEL
```

Health check:

```text
https://your-render-service.onrender.com/
```

### Production Frontend Backend URL

After backend deployment, update the production backend URL in `frontend/js/pages/chatPage.js` or provide `window.PLATEWISE_NLP_BASE`.

## Backend API

Backend entry file:

```text
nlp/nlp_api.py
```

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health/status check |
| `GET` | `/food-search?q=rice&limit=8` | Search local nutrition data for ingredient editing |
| `POST` | `/analyze-image` | Analyse a meal image and return detected meal data |
| `POST` | `/edit-meal` | Recalculate nutrition after ingredient edits |
| `POST` | `/meal-advice` | Generate advice for the current meal and user profile |
| `POST` | `/chat-turn` | Handle normal chat and profile/condition/goal update intents |
| `POST` | `/build-report` | Generate the final structured report for storage |

The backend reuses the original NLP logic in `platewise_streamlit_app.py` and related modules. It combines Gemini output, local food search, user profile context, allergy handling, condition extraction, and report structuring.

## Supabase Setup

### Core Tables

```text
users
user_profiles
reports
report_items
report_summaries
daily_summaries
```

### Optional Tables

```text
water_logs
exercise_logs
user_custom_ingredients
user_custom_activities
```

### Storage Buckets

```text
meal-images
profile-avatars
```

### RLS Policies

RLS policies are stored in:

```text
supabase/rls_policies.sql
```

Run this script in the Supabase SQL Editor after the main schema has been created.

## Data Files

| File | Purpose |
| --- | --- |
| `nlp/food_database.csv` | Local searchable food database |
| `nlp/usda_LLMprompt.csv` | USDA-style nutrition reference data |
| `nlp/nutrition5k_food_entity_library.json` | Food entity library |
| `nlp/disease_library.json` | Health condition reference data |
| `nlp/who_knowledge.json` | Nutrition guidance reference |
| `frontend/assets/MET_activities_with_activity_level.csv` | MET activity data for exercise calorie estimation |

## Troubleshooting

### PowerShell Blocks Scripts

If PowerShell blocks `.ps1` scripts, run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

For a temporary setting that only affects the current PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Python 3.12 Is Not Installed

This project uses Python 3.12 by default. If Python 3.12 is not available, check the installed Python versions:

```powershell
py -0p
```

If Python 3.11 is installed, run setup with:

```powershell
.\setup.ps1 -PythonVersion 3.11
```

For the most consistent setup, install Python 3.12 from:

```text
https://www.python.org/downloads/windows/
```

During installation, enable:

```text
Add python.exe to PATH
```

### Port Already in Use

If port `9000` or `5500` is already in use, stop the existing process or change the port in the command.

## Client Handover

Detailed handover notes are available at:

```text
docs/PROJECT_HANDOVER_DETAILS.md
```
