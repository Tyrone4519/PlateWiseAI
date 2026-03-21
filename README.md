## Project Structure
```bash
PlateAI/
├── README.md                 # Project overview, setup instructions, and usage
├── requirements.txt          # Python dependencies
├── .gitignore                # Files and folders to exclude from version control

├── data/
│   ├── raw/                  # Original datasets (e.g., FoodSeg103, Nutrition5K， WHO files...)
│   ├── processed/            # Cleaned and preprocessed data for modeling
│   └── sample/               # Small sample data for quick testing and demo

├── models/
│   ├── segmentation/         # Saved CV models 
│   ├── regression/           # Trained regression models
│   └── checkpoints/          # Model weights

├── src/
│   ├── cv/                   # Computer vision module (food detection & segmentation)
│   │   ├── segmentation.py   # Image segmentation logic
│   │   └── detection.py      # Food detection / classification logic
│
│   ├── regression/           # Nutrition prediction module
│   │   ├── train.py          # Model training scripts
│   │   ├── predict.py        # Inference / prediction functions
│   │   └── features.py       # Feature engineering and preprocessing
│
│   ├── nlp/                  # NLP module (food name correction)
│   │   └── food_correction.py 
│
│   ├── rag/                  # Retrieval-Augmented Generation (WHO knowledge base)
│   │   ├── build_index.py    # Build vector database from documents
│   │   └── retrieval.py      # Retrieve relevant guidelines
│
│   ├── pipeline/             # End-to-end system orchestration 
│   │   ├── pipeline.py       # Core workflow (connects all modules)
│   │   └── main.py           # Entry point for running the system
│
│   └── utils/                # Utility functions (shared across modules)
│       └── helpers.py        # Common helper methods

├── notebooks/                # Optional Jupyter notebooks (EDA, experiments, demos)
├── docs/                     # Documentation (architecture diagram, report, slides)
├── api/                      # optional
├── ui/                       # Frontend interface (web/app UI)
└── tests/                    # Unit tests and integration tests
```
