// Import necessary modules
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // For downloading Vimeo videos if needed
const OpenAI = require('openai'); // Not used now since Deepgram handles transcription
require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create an Express application
const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Gemini API Setup (for summarization, quiz, Q&A) ---
if (!process.env.GEMINI_API_KEY) {
    console.error("Gemini API key not found. Please set the GEMINI_API_KEY environment variable.");
    process.exit(1);
}

// Instead of using "new", call GoogleGenerativeAI as a function.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Adjust the model name as needed (here we use "gemini-pro" or "gemini-1.5-pro-latest")
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Deepgram API Setup (for transcription) ---
if (!process.env.DEEPGRAM_API_KEY) {
    console.error("Deepgram API key not found. Please set the DEEPGRAM_API_KEY environment variable.");
    process.exit(1);
}
const { DeepgramClient } = require("@deepgram/sdk");
const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

// --- Helper Functions ---

async function extractAudio(videoFilePath, outputAudioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(path.join(__dirname, videoFilePath))
            .output(outputAudioPath)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('end', () => {
                console.log('Audio extraction finished');
                resolve();
            })
            .on('error', (err) => {
                console.error('Error extracting audio:', err);
                reject(err);
            })
            .run();
    });
}

async function retryWithExponentialBackoff(operation, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (error.message.includes('429') && attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
}

async function retryDeepgramRequest(operation, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            console.warn(`Deepgram API error, retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * transcribeAudio:
 * Transcribes audio using Deepgram's API.
 */
async function transcribeAudio(audioFilePath) {
    try {
        await fs.promises.access(audioFilePath, fs.constants.R_OK);
        const stats = await fs.promises.stat(audioFilePath);
        if (stats.size === 0) {
            throw new Error('Audio file is empty');
        }
        const fileBuffer = await fs.promises.readFile(audioFilePath);
        const response = await retryDeepgramRequest(async () => {
            return await deepgram.transcription.preRecorded(fileBuffer, { mimetype: 'audio/wav' });
        });
        const transcript = response.results.channels[0].alternatives[0].transcript;
        return transcript;
    } catch (error) {
        console.error("Deepgram Transcription Error:", error);
        throw error;
    }
}

/**
 * translateText:
 * Translates text using the Gemini API with retry logic.
 */
async function translateText(text, targetLanguage) {
    return await retryWithExponentialBackoff(async () => {
        const prompt = `Translate the following text to ${targetLanguage}: ${text}`;
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });
        const response = await result.response;
        return response.text();
    });
}

/**
 * summarizeText:
 * Summarizes text using the Gemini API.
 */
async function summarizeText(text) {
    const prompt = `Summarize the following text concisely: ${text}`;
    return await retryWithExponentialBackoff(async () => {
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });
        const response = await result.response;
        return response.text();
    });
}

/**
 * generateQuiz:
 * Generates a quiz from text using the Gemini API.
 */
async function generateQuiz(text) {
    const prompt = `
        I want you to generate a quiz based on the following text. 
        The quiz should include 3 multiple-choice questions and 2 true/false questions.
        For each multiple-choice question, provide four answer options (A, B, C, D) and indicate the correct answer.
        For true/false questions, provide the question and state whether it is true or false.
        Text: ${text}
        
        Please format your response as a JSON object with the following structure:
        {
            "multipleChoice": [
                {
                    "question": "Question 1",
                    "options": { "A": "Option A", "B": "Option B", "C": "Option C", "D": "Option D" },
                    "correctAnswer": "A"
                },
                {
                    "question": "Question 2",
                    "options": { "A": "Option A", "B": "Option B", "C": "Option C", "D": "Option D" },
                    "correctAnswer": "B"
                },
                {
                    "question": "Question 3",
                    "options": { "A": "Option A", "B": "Option B", "C": "Option C", "D": "Option D" },
                    "correctAnswer": "C"
                }
            ],
            "trueFalse": [
                { "question": "True/False Question 1", "answer": true },
                { "question": "True/False Question 2", "answer": false }
            ]
        }
    `;
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let quiz = response.text().trim();
        if (quiz.startsWith("```")) {
            const lines = quiz.split("\n");
            if (lines[0].startsWith("```")) quiz = lines.slice(1).join("\n").trim();
            if (quiz.endsWith("```")) quiz = quiz.slice(0, -3).trim();
        }
        return JSON.parse(quiz);
    } catch (error) {
        console.error("Quiz generation error:", error);
        throw error;
    }
}

/**
 * answerQuestion:
 * Generates an answer based on provided context using the Gemini API.
 */
async function answerQuestion(context, question) {
    const prompt = `Based on the following context, identify and summarize the main idea:
Context: ${context}
Question: ${question}
Please provide a clear and concise summary of the main idea.`;
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Q&A error:", error);
        throw error;
    }
}

/**
 * downloadVideo:
 * Downloads a video from a given URL (e.g., Vimeo) and saves it to the local filesystem.
 */
async function downloadVideo(videoUrl, outputPath) {
    try {
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: 10000 // Increase timeout to 10 seconds
        });
        const writer = fs.createWriteStream(path.join(__dirname, 'videos', path.basename(outputPath)));
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error("Download error:", error);
        // Implement retry mechanism
        if (error.code === 'ENOTFOUND') {
            console.log('DNS resolution failed, retrying in 3 seconds...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            return downloadVideo(videoUrl, outputPath); // Recursive call
        }
        throw error;
    }
}

/**
 * removeMarkdownFormatting:
 * Removes markdown code fences from a JSON string.
 */
function removeMarkdownFormatting(jsonString) {
    return jsonString.replace(/```json\n|\n```/g, '');
}

// --- API Endpoints ---

// Health-check endpoint
app.get('/', (req, res) => {
    res.send('Server is running');
});

// Endpoint for processing video uploaded via file
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded.' });
        }
        // Validate file type
        const allowedTypes = ['.mp4', '.avi', '.mov', '.wmv'];
        const fileExt = path.extname(req.file.originalname).toLowerCase();
        if (!allowedTypes.includes(fileExt)) {
            return res.status(400).json({
                error: 'Invalid file type',
                details: `Supported formats: ${allowedTypes.join(', ')}`
            });
        }
        const videoFilePath = req.file.path;
        const audioFilePath = path.join(uploadsDir, `${path.basename(videoFilePath, path.extname(videoFilePath))}.wav`);
        await extractAudio(videoFilePath, audioFilePath);
        const transcript = await transcribeAudio(audioFilePath);
        // Clean up temporary files
        try {
            await Promise.all([
                fs.promises.unlink(audioFilePath),
                fs.promises.unlink(videoFilePath)
            ]);
        } catch (cleanupError) {
            console.error('Error cleaning up files:', cleanupError);
        }
        res.json({ transcript: transcript });
    } catch (error) {
        console.error("Transcription API error:", error);
        res.status(500).json({
            error: 'Failed to transcribe video.',
            details: error.message,
            path: req.file?.path
        });
    }
});

// New endpoint: Process Vimeo video by URL
app.post('/api/process-vimeo', async (req, res) => {
    try {
        const { videoUrl } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ error: 'videoUrl is required.' });
        }
        // Determine file extension (default to .mp4 if not present)
        const fileExt = path.extname(videoUrl) || '.mp4';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const videoFilename = 'vimeo-' + uniqueSuffix + fileExt;
        const videoFilePath = path.join(uploadsDir, videoFilename);
        // Download video from Vimeo
        await downloadVideo(videoUrl, videoFilePath);
        const audioFilePath = path.join(uploadsDir, `${path.basename(videoFilename, fileExt)}.wav`);
        await extractAudio(videoFilePath, audioFilePath);
        const transcript = await transcribeAudio(audioFilePath);
        // Optional: Save transcript and metadata to the database here
        // Clean up temporary files
        try {
            await Promise.all([
                fs.promises.unlink(audioFilePath),
                fs.promises.unlink(videoFilePath)
            ]);
        } catch (cleanupError) {
            console.error('Error cleaning up files:', cleanupError);
        }
        res.json({ transcript: transcript });
    } catch (error) {
        console.error("Vimeo processing error:", error);
        res.status(500).json({ error: 'Failed to process Vimeo video.', details: error.message });
    }
});

// Endpoint for translating text using Gemini API
app.post('/api/translate', async (req, res) => {
    try {
        const { text, targetLanguage } = req.body;
        if (!text || !targetLanguage) {
            return res.status(400).json({ error: 'Both text and targetLanguage are required.' });
        }
        const translatedText = await translateText(text, targetLanguage);
        res.json({ translatedText: translatedText });
    } catch (error) {
        console.error("Translation API error:", error);
        res.status(500).json({ error: 'Failed to translate text.', details: error.message });
    }
});

// Endpoint for summarizing text using Gemini API
app.post('/api/summarize', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required for summarization.' });
        }
        const summary = await summarizeText(text);
        res.json({ summary: summary });
    } catch (error) {
        console.error("Summarization API error:", error);
        res.status(500).json({ error: 'Failed to summarize text.', details: error.message });
    }
});

// Endpoint for generating a quiz using Gemini API
app.post('/api/generate-quiz', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required for quiz generation.' });
        }
        const quiz = await generateQuiz(text);
        res.json({ quiz: quiz });
    } catch (error) {
        console.error("Quiz generation API error:", error);
        res.status(500).json({ error: 'Failed to generate quiz.', details: error.message });
    }
});

// Endpoint for interactive Q&A using Gemini API
app.post('/api/qa', async (req, res) => {
    try {
        const { context, question } = req.body;
        if (!context || !question) {
            return res.status(400).json({ error: 'Both context and question are required.' });
        }
        const prompt = `
            Based on the following context, answer the question provided:
            Context: ${context}
            Question: ${question}
            Please format your response as a JSON object with the following structure:
            {
                "qa": [
                    {
                        "question": "${question}",
                        "answer": "Answer"
                    }
                ]
            }
        `;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const qa = response.text();
        try {
            const qaJSON = JSON.parse(removeMarkdownFormatting(qa));
            res.json({ qa: qaJSON });
        } catch (parseError) {
            console.error("Error parsing Q&A JSON:", parseError);
            res.json({ error: "Could not parse Q&A JSON", raw: qa });
        }
    } catch (error) {
        console.error("Q&A API error:", error);
        res.status(500).json({ error: 'Failed to generate Q&A.', details: error.message });
    }
});

// Endpoint for searching transcripts (placeholder)
app.post('/api/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query parameter is required for search.' });
        }
        const searchResults = [
            { videoId: 'video1', snippet: `Snippet from video1 containing "${query}"` },
            { videoId: 'video2', snippet: `Snippet from video2 containing "${query}"` }
        ];
        res.json({ results: searchResults });
    } catch (error) {
        console.error("Search API error:", error);
        res.status(500).json({ error: 'Failed to perform search.', details: error.message });
    }
});

// Function to remove Markdown formatting from JSON responses
function removeMarkdownFormatting(jsonString) {
    return jsonString.replace(/```json\n|\n```/g, '');
}

app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
});
