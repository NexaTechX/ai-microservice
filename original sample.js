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

// Configure ffmpeg path - FIX FOR ERROR #1
// Uncomment and adjust this line to specify the path to your ffmpeg executable
// ffmpeg.setFfmpegPath('/usr/local/bin/ffmpeg'); // On Linux/Mac
// ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe'); // On Windows

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

// FIX FOR ERRORS #2-5: Update Gemini model name and API version
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using the updated model name based on latest API changes
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// --- Assembly AI Setup (for transcription) ---
if (!process.env.ASSEMBLY_AI_API_KEY || process.env.ASSEMBLY_AI_API_KEY === 'your_assembly_ai_api_key_here') {
    console.error("Assembly AI API key not found or not configured properly. Please set the ASSEMBLY_AI_API_KEY environment variable.");
    process.exit(1);
}

const { AssemblyAI } = require('assemblyai');
const assemblyai = new AssemblyAI({
    apiKey: process.env.ASSEMBLY_AI_API_KEY
});

async function transcribeWithAssemblyAI(audioFilePath) {
    try {
        const transcript = await assemblyai.transcripts.create({
            audio_url: `file://${audioFilePath}`
        });
        
        // Wait for the transcription to complete
        const result = await assemblyai.transcripts.waitUntilReady(transcript.id);
        return result.text;
    } catch (error) {
        console.error('Assembly AI transcription error:', error);
        throw error;
    }
}

// --- Helper Functions ---

async function extractAudio(videoFilePath, outputAudioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoFilePath) // FIX FOR ERROR #1: Changed from path.join(__dirname, videoFilePath)
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
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
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
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
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
        
        return await transcribeWithAssemblyAI(audioFilePath);

    } catch (error) {
        console.error("Transcription Error:", error);
        throw new Error(`Transcription failed: ${error.message}`);
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
        // FIX: Updated to match new API pattern
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });
        const response = await result.response;
        let quiz = response.text().trim();
        if (quiz.startsWith("```")) {
            const lines = quiz.split("\n");
            if (lines[0].startsWith("```")) quiz = lines.slice(1).join("\n").trim();
            if (quiz.endsWith("```")) quiz = quiz.slice(0, -3).trim();
        }
        return JSON.parse(quiz);
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
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
        // FIX: Updated to match new API pattern
        const result = await model.generateContent({
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });
        const response = await result.response;
        return response.text();
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
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
        // Validate URL
        if (!videoUrl.startsWith('http')) {
            throw new Error('Invalid video URL format');
        }

        // Ensure uploads directory exists
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: 30000, // Increase timeout to 30 seconds for larger videos
            maxContentLength: 500 * 1024 * 1024 // 500MB max file size
        });

        const writer = fs.createWriteStream(outputPath);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`Successfully downloaded video to ${outputPath}`);
                resolve();
            });
            writer.on('error', (err) => {
                fs.unlink(outputPath, () => {}); // Cleanup on error
                reject(err);
            });
            response.data.on('error', (err) => {
                writer.end();
                fs.unlink(outputPath, () => {});
                reject(err);
            });
        });
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        // Cleanup the partial file if it exists
        if (fs.existsSync(outputPath)) {
            await fs.promises.unlink(outputPath).catch(() => {});
        }
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
    return jsonString.replace(/```json\n|\n```/g, '').replace(/```\s*|\s*```/g, '');
}

// --- API Endpoints ---

// Health-check endpoint
app.get('/', (req, res) => {
    res.send('Server is running');
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
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
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
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
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        console.error("Vimeo processing error:", error);
        res.status(500).json({ error: 'Failed to process Vimeo video.', details: error.message });
    }
});

// Endpoint for summarizing text using Gemini API
app.post('/api/summarize', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required.' });
        }
        const summary = await summarizeText(text);
        res.json({ summary: summary });
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        console.error("Summarization error:", error);
        res.status(500).json({ error: 'Failed to summarize text.', details: error.message });
    }
});

// Endpoint for generating quiz using Gemini API
app.post('/api/generate-quiz', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required.' });
        }
        const quiz = await generateQuiz(text);
        res.json({ quiz: quiz });
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        console.error("Quiz generation error:", error);
        res.status(500).json({ error: 'Failed to generate quiz.', details: error.message });
    }
});

// Endpoint for Q&A using Gemini API
app.post('/api/qa', async (req, res) => {
    try {
        const { context, question } = req.body;
        if (!context || !question) {
            return res.status(400).json({ error: 'Both context and question are required.' });
        }
        const answer = await answerQuestion(context, question);
        res.json({ answer: answer });
    } catch (error) {
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        console.error("Q&A error:", error);
        res.status(500).json({ error: 'Failed to answer question.', details: error.message });
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
        // Provide more specific error messages
        if (error.code === 'ECONNABORTED') {
            throw new Error('Video download timed out. The file might be too large or the server is slow.');
        } else if (error.response) {
            throw new Error(`Failed to download video: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error('No response received from the video server. Please check the URL and try again.');
        } else {
            throw new Error(`Failed to download video: ${error.message}`);
        }
        console.error("Translation error:", error);
        res.status(500).json({ error: 'Failed to translate text.', details: error.message });
    }
});