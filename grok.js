const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const { DeepgramClient } = require('@deepgram/sdk');
const { v4: uuidv4 } = require('uuid'); // For unique filenames

// Set up directories
const uploadsDir = path.join(__dirname, 'uploads');
const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Deepgram setup
if (!process.env.DEEPGRAM_API_KEY) {
    console.error("Deepgram API key not found. Please set DEEPGRAM_API_KEY in .env.");
    process.exit(1);
}
const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

// Helper Functions

/** Downloads a video from Vimeo to the videos folder */
async function downloadVideo(videoUrl) {
    try {
        console.log('Extracting video ID from URL:', videoUrl);
        const videoIdMatch = videoUrl.match(/vimeo\.com\/(\d+)/);
        if (!videoIdMatch) throw new Error('Invalid Vimeo URL');
        const vimeoId = videoIdMatch[1];

        console.log('Fetching video page');
        const videoPageResponse = await axios.get(videoUrl, { timeout: 10000 });
        const videoPageHtml = videoPageResponse.data;

        console.log('Extracting config URL');
        const configUrlMatch = videoPageHtml.match(/"config_url":"([^"]+)"/);
        if (!configUrlMatch) throw new Error('Could not find config URL');
        const configUrl = configUrlMatch[1].replace(/\\/g, '');

        console.log('Fetching config JSON');
        const configResponse = await axios.get(configUrl, { timeout: 10000 });
        const configData = configResponse.data;

        console.log('Extracting direct video URL');
        const videoFiles = configData.request.files.progressive;
        if (!videoFiles || videoFiles.length === 0) throw new Error('No video files found');
        videoFiles.sort((a, b) => b.width - a.width); // Highest quality first
        const directVideoUrl = videoFiles[0].url;

        const videoFilename = `${vimeoId}-${uuidv4()}.mp4`;
        const videoFilePath = path.join(videosDir, videoFilename);

        console.log('Downloading video to:', videoFilePath);
        const response = await axios({
            method: 'GET',
            url: directVideoUrl,
            responseType: 'stream',
            timeout: 30000
        });
        const writer = fs.createWriteStream(videoFilePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log('Video downloaded successfully');
                resolve(videoFilePath);
            });
            writer.on('error', (err) => reject(new Error(`Download failed: ${err.message}`)));
        });
    } catch (error) {
        throw new Error(`Failed to download video: ${error.message}`);
    }
}

/** Extracts audio from a video file */
async function extractAudio(videoFilePath, outputAudioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoFilePath)
            .output(outputAudioPath)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('end', () => {
                console.log('Audio extracted successfully');
                resolve();
            })
            .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
            .run();
    });
}

/** Transcribes audio using Deepgram */
async function transcribeAudio(audioFilePath) {
    try {
        await fs.promises.access(audioFilePath, fs.constants.R_OK);
        const stats = await fs.promises.stat(audioFilePath);
        if (stats.size === 0) throw new Error('Audio file is empty');
        const fileBuffer = await fs.promises.readFile(audioFilePath);
        const response = await deepgram.listen.prerecorded.transcribeFile(fileBuffer, {
            mimetype: 'audio/wav',
            model: 'nova'
        });
        const transcript = response.results.channels[0].alternatives[0].transcript;
        if (!transcript) throw new Error('Transcription returned empty');
        return transcript;
    } catch (error) {
        throw new Error(`Transcription failed: ${error.message}`);
    }
}

// API Endpoint
app.post('/api/process-vimeo', async (req, res) => {
    console.log('Received request to /api/process-vimeo');
    try {
        const { videoUrl } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ error: 'videoUrl is required' });
        }

        // Download video to videos folder
        const videoFilePath = await downloadVideo(videoUrl);

        // Verify the video file exists and has content
        const stats = await fs.promises.stat(videoFilePath);
        if (stats.size === 0) throw new Error('Downloaded video file is empty');

        // Extract audio
        const audioFilePath = path.join(uploadsDir, `${path.basename(videoFilePath, '.mp4')}.wav`);
        await extractAudio(videoFilePath, audioFilePath);

        // Transcribe audio
        const transcript = await transcribeAudio(audioFilePath);

        // Clean up temporary audio file
        await fs.promises.unlink(audioFilePath);
        console.log('Temporary audio file deleted');

        // Respond with transcript and video path
        res.json({ transcript, videoFilePath });
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({ error: 'Failed to process Vimeo video', details: error.message });
    }
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});
