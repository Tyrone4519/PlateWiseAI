# PlateWise AI

PlateWise AI is a full-stack AI nutrition assistant designed to help users record meals, analyze meal images, manage personal dietary profiles, and generate nutrition reports. The project combines a mobile-style web frontend, a FastAPI NLP backend, Supabase database/storage/authentication, Gemini vision-language models, USDA nutrition data, and custom NLP logic.

The application is designed around a simple goal: users can upload or take a photo of a meal, ask nutrition-related questions, edit detected ingredients, generate a structured report, and review their historical nutrition records.

---

## Project Overview

PlateWise AI supports:

- User sign up and login
- Email confirmation flow
- New user onboarding
- Personal profile management
- Meal image upload and camera capture
- AI meal image analysis
- Editable detected ingredients
- Custom ingredient search and saving
- Chat-based nutrition advice
- Automatic report generation
- Report item storage with calories, protein, fat, carbs, sodium, sugar, and fiber
- Meal image storage
- History search and report detail view
- Dashboard nutrition summary
- Hydration tracking
- Activity / exercise tracking
- Profile avatar upload
- Dietary restrictions and health condition management

The app is not intended to provide medical diagnosis. It provides nutrition support and general dietary guidance.

---

## System Architecture

The project uses a separated frontend and backend architecture.

```text
User Browser
    ↓
Frontend Web App
    ↓
Supabase Auth / Database / Storage
    ↓
FastAPI NLP Backend
    ↓
Gemini API + USDA API + Local NLP Modules

---

### For local development:

Frontend: http://127.0.0.1:5500/frontend/index.html
NLP API:  http://127.0.0.1:9000

---

#### For cloud deployment:

Frontend: GitHub Pages
Backend:  Render Web Service / Vercel Web Service
Database: Supabase
Storage:  Supabase Storage
Auth:     Supabase Auth

Main Tech Stack
Frontend
HTML
CSS
JavaScript ES Modules
Supabase JavaScript Client
Mobile-app style UI
GitHub Pages deployment
Backend
Python 3.12
FastAPI
Uvicorn
Pydantic
Pillow
Pandas
Streamlit-compatible NLP logic
Google GenAI SDK
USDA data integration
Database and Storage
Supabase Auth
Supabase PostgreSQL
Supabase Storage
Row Level Security policies
AI and Nutrition APIs
Gemini API for image and language understanding
USDA API / USDA local prompt data for nutrition reference
Local NLP modules for intent recognition, profile updates, food extraction, condition handling, and meal correction

---

##### Folder Structure
PlateWiseAI/
├─ frontend/
│  ├─ index.html
│  ├─ confirm.html
│  ├─ onboarding.html
│  ├─ dashboard.html
│  ├─ chat.html
│  ├─ history.html
│  ├─ meal-detail.html
│  ├─ profile.html
│  ├─ style.css
│  ├─ assets/
│  │  ├─ MET_activities_with_activity_level.csv
│  │  └─ colorful_egg/
│  └─ js/
│     ├─ config.js
│     ├─ lib/
│     │  ├─ auth.js
│     │  ├─ data.js
│     │  ├─ router.js
│     │  ├─ supabaseClient.js
│     │  └─ utils.js
│     └─ pages/
│        ├─ indexPage.js
│        ├─ onboardingPage.js
│        ├─ dashboardPage.js
│        ├─ chatPage.js
│        ├─ historyPage.js
│        ├─ mealDetailPage.js
│        └─ profilePage.js
│
├─ nlp/
│  ├─ nlp_api.py
│  ├─ platewise_streamlit_app.py
│  ├─ food_extractor.py
│  ├─ user_correction.py
│  ├─ condition_extractor.py
│  ├─ condition_intent.py
│  ├─ goal_update_intent.py
│  ├─ preference_intent.py
│  ├─ weight_update_intent.py
│  ├─ intent_recognition_defs.py
│  ├─ embedding_utils.py
│  ├─ disease_library.json
│  ├─ who_knowledge.json
│  ├─ nutrition5k_food_entity_library.json
│  ├─ food_database.csv
│  ├─ usda_LLMprompt.csv
│  └─ requirements.txt
│
├─ supabase/
│  └─ rls_policies.sql
│
├─ .github/
│  └─ workflows/
│
├─ .gitignore
└─ README.md

---

###### Frontend Features

1. Authentication

The login page supports:

Email login
Email sign up
Supabase Auth session handling
Invalid session cleanup
Automatic routing after login

After login:

If the profile is incomplete, the user is redirected to onboarding.
If the profile is complete, the user is redirected to dashboard.

The email confirmation flow uses confirm.html, allowing users to confirm their email and then manually return to the login page.

2. Onboarding

New users must complete onboarding before using the full app.

The onboarding page collects:

Name
Age
Gender
Height
Weight
Goal
Activity level
Allergies / dietary restrictions
Health conditions
Optional avatar preview

Supported goals include:

lose_weight
gain_weight
gain_muscle
maintain

The onboarding data is saved to the user_profiles table in Supabase.

3. Dashboard

The dashboard gives a nutrition overview based on saved reports and daily summaries.

It includes:

Today's meal count
Estimated calorie intake
Sodium intake
Sugar intake
Macro progress
Seven-day nutrition trend
Daily summary cards
Hydration tracking
Optional hydration goal adjustment
Activity / exercise logging
Activity calorie estimation using MET values
Custom activity template support
Quick navigation to Chat and Profile

Dashboard data mainly comes from:

reports
daily_summaries
user_profiles
Optional water_logs
Optional exercise_logs
Optional user_custom_activities

If optional activity or water tables are not configured, the core nutrition report features can still work.

4. Chat Page

The Chat page is the main AI interaction page.

It supports:

Meal image upload
Camera capture
Image preview
Image compression before upload
Image analysis through local or deployed NLP backend
Normal chat with the AI assistant
Meal advice based on the user's profile
Detected ingredient editing
Food search
Custom ingredient creation
Custom ingredient history
Ingredient weight adjustment
Meal recalculation
Report generation
Meal image upload to Supabase Storage
Report saving to Supabase
Automatic daily summary update
Automatic profile update if the NLP output includes profile changes

Local backend URL:

http://127.0.0.1:9000

The Chat page calls these NLP endpoints:

GET  /food-search
POST /analyze-image
POST /edit-meal
POST /meal-advice
POST /chat-turn
POST /build-report

5. Ingredient Editing

After a meal image is analyzed, the detected ingredients can be reviewed and edited before generating a final report.

The user can:

Rename ingredients
Search food items
Add custom ingredients
Remove ingredients
Change estimated grams
Save edits
Confirm ingredients before report generation

The edited meal is then used for the final report generation.

6. Report Generation

When the user clicks the Report button, the app:

Sends the current meal and profile to the NLP backend.
Receives structured report data.
Uploads the meal image to Supabase Storage.
Inserts the main report into reports.
Inserts each detected food item into report_items.
Inserts full JSON output into report_summaries.
Updates daily_summaries.
Applies profile_updates to user_profiles if returned by NLP.

Saved report fields include:

title
report_date
source_type
image_url
risk_level
final_summary
recommendation
total_calories
total_protein_g
total_fat_g
total_carbs_g
total_sodium_mg
total_sugar_g
total_fiber_g

Saved report item fields include:

food_name
estimated_portion
portion_unit
calories
protein_g
fat_g
carbs_g
sodium_mg
sugar_g
fiber_g
confidence_score
notes

7. History Page

The History page displays saved reports.

It supports:

Report list view
Keyword search
Date filtering
Calendar-style filters
Image thumbnails
Risk level display
Nutrition summary per report
Search by title, summary, recommendation, ingredients, and report details
Navigation to a detailed report page

8. Meal Detail Page

The meal detail page shows a full report selected from History.

It displays:

Meal title
Report date
Risk level
Meal image
Nutrition summary
Report items
Calories / protein / carbs / fat / sodium / sugar / fiber
Final analysis text
Recommendation
Full structured summary where available

9. Profile Page

The Profile page supports:

Viewing user profile
Editing goal
Editing biometrics
Editing restrictions
Editing health notes
Avatar upload
Activity level display
Logout
Navigation back to Chat

Profile data is stored in user_profiles.

Important profile fields include:

name
age
gender
height_cm
weight_kg
goal
restrictions
health_notes
avatar_url
activity_level

---
####### Backend / NLP Features

The backend is built with FastAPI and is located in:

nlp/nlp_api.py

The backend wraps and reuses the original PlateWise NLP logic from:

platewise_streamlit_app.py
food_extractor.py
user_correction.py
condition_extractor.py
condition_intent.py
goal_update_intent.py
preference_intent.py
weight_update_intent.py
intent_recognition_defs.py
embedding_utils.py

The backend is not only a direct Gemini wrapper. It combines:

Gemini image / language model output
USDA nutrition references
Local food database search
User profile context
Intent recognition
Allergy / restriction handling
Condition extraction
Weight / goal update detection
WHO-style nutrition knowledge
Meal correction logic
Report structuring logic

---
######## Backend API Endpoints

--- Root

GET /

Returns backend running status.

--- Food Search

GET /food-search?q=rice&limit=8

Searches local food data and returns matched foods for ingredient editing.

--- Analyze Image

POST /analyze-image

Accepts:

image file
user profile
goal

Returns:

AI reply
detected meal
ingredients
nutrition estimates
profile context
possible profile updates

--- Edit Meal

POST /edit-meal

Accepts:

current meal
profile
edited ingredients

Returns:

updated meal
recalculated nutrition
updated advice

--- Meal Advice

POST /meal-advice

Accepts:

current meal
profile

Returns nutrition advice based on the user's current profile and meal.

--- Chat Turn

POST /chat-turn

Handles normal user chat.

It can process:

meal questions
profile questions
restriction updates
allergy statements
condition-related messages
goal updates
meal correction requests

--- Build Report

POST /build-report

Generates the final structured report.

Returns:

title
insight
final summary
recommendation
risk level
report totals
items for database
possible profile updates

---
######## Supabase Database

The main Supabase tables are:

users
user_profiles
reports
report_items
report_summaries
daily_summaries

The project can also use extended optional tables for dashboard and custom features:

water_logs
exercise_logs
user_custom_ingredients
user_custom_activities

Core report functionality depends mainly on:

users
user_profiles
reports
report_items
report_summaries
daily_summaries

--- Supabase Storage Buckets

The app uses Supabase Storage for uploaded files.

Recommended buckets:

meal-images
profile-avatars

meal-images stores uploaded meal photos.

profile-avatars stores user avatar images.

--- Environment Variables

Create this file locally:

nlp/.env

Example:

GEMINI_API_KEY=your_gemini_api_key
USDA_API_KEY=your_usda_api_key
GEMINI_MODEL=gemini-3.1-flash-lite-preview

Do not commit .env to GitHub.

For Render deployment, add these variables in Render Environment settings:

GEMINI_API_KEY
USDA_API_KEY
GEMINI_MODEL

--- Supabase Frontend Configuration

Frontend Supabase configuration is stored in:

frontend/js/config.js

Example:

export const APP_CONFIG = {
  APP_NAME: "PlateWise AI",
  SUPABASE_URL: "your_supabase_project_url",
  SUPABASE_PUBLISHABLE_KEY: "your_supabase_publishable_key",
  DEFAULT_AVATAR: "P",
};

The Supabase publishable / anon key is visible in frontend code because the browser needs it. This is normal only if Row Level Security is properly configured.

Never expose:

SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
USDA_API_KEY

in frontend code or GitHub.

---
######### Local Installation

This project is tested with Python 3.12.

1. Clone the repository

git clone https://github.com/your-username/PlateWiseAI.git
cd PlateWiseAI

2. Create a Python virtual environment
cd nlp
py -3.12 -m venv .venv
3. Activate the virtual environment

--- PowerShell:

.\.venv\Scripts\Activate.ps1

If PowerShell blocks script execution:

Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

Then activate again:

.\.venv\Scripts\Activate.ps1
4. Install backend dependencies
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
5. Create .env

Inside the nlp folder:

nlp/.env

Add:

GEMINI_API_KEY=your_gemini_api_key
USDA_API_KEY=your_usda_api_key
GEMINI_MODEL=gemini-3.1-flash-lite-preview
6. Run the NLP backend locally

From the nlp folder:

python -m uvicorn nlp_api:app --reload --port 9000

Backend should be available at:

http://127.0.0.1:9000

API docs:

http://127.0.0.1:9000/docs

--- Run the Frontend Locally

Open another terminal from the project root:

cd PlateWiseAI
py -3.12 -m http.server 5500

Then visit:

http://127.0.0.1:5500/frontend/index.html

For local testing, the frontend automatically uses:

http://127.0.0.1:9000

as the NLP backend.

--- Local Test Flow

Recommended local test order:

1. Start NLP backend on port 9000
2. Start frontend server on port 5500
3. Open frontend login page
4. Login or create account
5. Complete onboarding
6. Go to Chat
7. Upload a meal image
8. Click Analyze
9. Edit detected ingredients if needed
10. Generate Report
11. Check History
12. Open Meal Detail
13. Check Dashboard
14. Check Profile updates

---
########## GitHub Pages Deployment

The frontend is deployed as a static site.

Recommended GitHub repository structure:

PlateWiseAI/
├─ frontend/
├─ nlp/
├─ supabase/
└─ .github/workflows/

The GitHub Pages workflow should deploy the frontend/ folder.

After pushing changes:

git add frontend nlp supabase .gitignore README.md
git commit -m "Update PlateWise AI"
git pull --rebase origin main
git push origin main

Then check:

GitHub → Actions

Wait until the deployment is green.

Frontend URL example:

https://your-username.github.io/PlateWiseAI/

--- Render Backend Deployment

The NLP backend is deployed as a Render Web Service.

Render settings:

Root Directory: nlp
Build Command: pip install -r requirements.txt
Start Command: uvicorn nlp_api:app --host 0.0.0.0 --port $PORT

Environment variables:

GEMINI_API_KEY
USDA_API_KEY
GEMINI_MODEL

After pushing backend changes to GitHub:

Render → platewise-nlp → Manual Deploy → Deploy latest comm

Or enable Auto Deploy.

Test the deployed backend:

https://your-render-service.onrender.com/

---
########### Frontend Backend URL Setting

In:

frontend/js/pages/chatPage.js

The app uses local NLP during development:

http://127.0.0.1:9000

For production, update the Render backend URL:

const NLP_BASE = IS_LOCAL
  ? "http://127.0.0.1:9000"
  : "https://your-render-service.onrender.com";

Make sure this URL matches the actual Render service URL.

---
############ Security Notes

The following files and folders should not be committed:

.env
.venv/
__pycache__/
*.pyc

Supabase publishable / anon key can appear in frontend code, but database access must be protected by RLS policies.

Never expose:

SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
USDA_API_KEY

If any private key is accidentally pushed to GitHub, rotate that key immediately.

---
############ Known Limitations

Gemini image analysis may sometimes return temporary high-demand errors.
Render free instances may sleep when inactive and can be slower on the first request.
Large images may increase backend memory usage, so the frontend compresses images before upload.
Nutrition estimation is approximate and should not be treated as medical diagnosis.
More accurate food quantity estimation would require further model and dataset improvements.

---
############# Future Improvements

Potential next steps:

Improve ingredient-level nutrition accuracy
Add a full report export feature
Add doctor / caregiver dashboard
Add better weekly and monthly analytics
Add food barcode scanning
Add multi-language support
Add stronger medical disclaimers
Improve RLS policies for production use
Add automated testing
Convert the frontend into a PWA mobile app