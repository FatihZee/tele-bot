const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true 
})
.then(() => console.log('MongoDB Atlas Connected'))
.catch((err) => console.error('Error connecting to MongoDB Atlas:', err));

const Video = mongoose.model('Video', new mongoose.Schema({
    platform: String,
    video_url: String,
    video_thumbnail: String,
    original_url: String,
    date_added: { type: Date, default: Date.now }
}));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const platformPatterns = JSON.parse(process.env.PLATFORM_PATTERNS);

async function saveVideo(platform, videoUrl, videoThumbnail, originalUrl) {
    const video = new Video({ 
        platform: platform,
        video_url: videoUrl, 
        video_thumbnail: videoThumbnail,
        original_url: originalUrl
    });
    await video.save();
    console.log(`Saved ${platform} media to database`);
}

async function downloadMedia(url) {
    const options = {
        method: 'POST',
        url: process.env.RAPIDAPI_URL,
        headers: {
            'x-rapidapi-key': process.env.RAPIDAPI_KEY,
            'x-rapidapi-host': process.env.RAPIDAPI_HOST,
            'Content-Type': 'application/json'
        },
        data: { url: url }
    };

    try {
        const response = await axios.request(options);
        console.log("API Response Source:", response.data.source);
        
        const platform = response.data.source || identifyPlatform(url) || 'unknown';
        
        if (response.data && response.data.medias && response.data.medias.length > 0) {
            let bestVideo = null;
            let bestAudio = null;
            let bestImage = null;
            
            bestVideo = response.data.medias.find(media => 
                media.type === "video" && media.quality === "no_watermark");
            
            if (!bestVideo) {
                bestVideo = response.data.medias.find(media => 
                    media.type === "video" && media.quality === "hd_no_watermark");
            }
            
            if (!bestVideo) {
                bestVideo = response.data.medias.find(media => media.type === "video");
            }
            
            bestAudio = response.data.medias.find(media => media.type === "audio");
            
            if (!bestVideo) {
                bestImage = response.data.medias.find(media => 
                    media.type === "image" || media.extension === "jpg" || media.extension === "png");
            }
            
            if (bestVideo) {
                return { 
                    platform: platform,
                    mediaUrl: bestVideo.url, 
                    thumbnail: response.data.thumbnail || '',
                    type: 'video',
                    extension: bestVideo.extension || 'mp4'
                };
            } else if (bestAudio) {
                return {
                    platform: platform,
                    mediaUrl: bestAudio.url,
                    thumbnail: response.data.thumbnail || '',
                    type: 'audio',
                    extension: bestAudio.extension || 'mp3'
                };
            } else if (bestImage) {
                return {
                    platform: platform,
                    mediaUrl: bestImage.url,
                    thumbnail: response.data.thumbnail || '',
                    type: 'image',
                    extension: bestImage.extension || 'jpg'
                };
            }
        } else if (response.data && response.data.url) {
            const urlLower = response.data.url.toLowerCase();
            let type = 'video';
            let extension = 'mp4';
            
            if (urlLower.endsWith('.mp3') || urlLower.endsWith('.wav') || urlLower.endsWith('.ogg')) {
                type = 'audio';
                extension = urlLower.split('.').pop();
            } else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg') || 
                      urlLower.endsWith('.png') || urlLower.endsWith('.gif')) {
                type = 'image';
                extension = urlLower.split('.').pop();
            }
            
            return {
                platform: platform,
                mediaUrl: response.data.url,
                thumbnail: response.data.thumbnail || '',
                type: type,
                extension: extension
            };
        }
        
        throw new Error('Media not found or failed to fetch.');
    } catch (error) {
        console.error('Error downloading media:', error.message);
        throw error;
    }
}

async function sendMediaToUser(ctx, mediaInfo) {
    try {
        await ctx.reply(`Sedang mengunduh ${mediaInfo.type} dari ${mediaInfo.platform}, mohon tunggu sebentar...`);
        
        const response = await axios.get(mediaInfo.mediaUrl, { 
            responseType: 'arraybuffer',
            timeout: 90000
        });
        
        const timestamp = Date.now();
        let filePath;
        
        if (mediaInfo.type === 'video') {
            filePath = path.join(__dirname, `video_${timestamp}.${mediaInfo.extension || 'mp4'}`);
        } else if (mediaInfo.type === 'audio') {
            filePath = path.join(__dirname, `audio_${timestamp}.${mediaInfo.extension || 'mp3'}`);
        } else if (mediaInfo.type === 'image') {
            filePath = path.join(__dirname, `image_${timestamp}.${mediaInfo.extension || 'jpg'}`);
        } else {
            filePath = path.join(__dirname, `media_${timestamp}.${mediaInfo.extension || 'bin'}`);
        }
        
        fs.writeFileSync(filePath, response.data);
        
        try {
            if (mediaInfo.type === 'video') {
                await ctx.replyWithVideo(
                    { source: filePath }, 
                    { caption: `Video dari ${mediaInfo.platform}` }
                );
            } else if (mediaInfo.type === 'audio') {
                await ctx.replyWithAudio(
                    { source: filePath }, 
                    { caption: `Audio dari ${mediaInfo.platform}` }
                );
            } else if (mediaInfo.type === 'image') {
                await ctx.replyWithPhoto(
                    { source: filePath }, 
                    { caption: `Gambar dari ${mediaInfo.platform}` }
                );
            } else {
                await ctx.replyWithDocument(
                    { source: filePath }, 
                    { caption: `Media dari ${mediaInfo.platform}` }
                );
            }
        } catch (sendError) {
            console.error('Error sending media, trying as document:', sendError);
            await ctx.replyWithDocument(
                { source: filePath }, 
                { caption: `Media dari ${mediaInfo.platform} (dikirim sebagai file)` }
            );
        }
        
        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting file:', err);
        });
    } catch (error) {
        console.error('Error sending media to user:', error);
        ctx.reply(`Terjadi kesalahan saat mengirim ${mediaInfo.type}. Media mungkin terlalu besar atau tidak tersedia.`);
    }
}

function identifyPlatform(url) {
    const urlLower = url.toLowerCase();
    
    for (const platform of platformPatterns) {
        for (const pattern of platform.patterns) {
            if (urlLower.includes(pattern)) {
                return platform.name;
            }
        }
    }
    
    return null;
}

function getSupportedPlatformsList() {
    return platformPatterns
        .map(p => p.name)
        .sort()
        .join(', ');
}

bot.start((ctx) => {
    ctx.reply(
        'Selamat datang di Multi-Platform Media Downloader Bot!\n\n' +
        'Bot ini dapat mengunduh video, audio, dan gambar dari berbagai platform media sosial dan situs web.\n\n' +
        'Kirimkan link untuk mengunduh media, atau gunakan /help untuk informasi lebih lanjut.'
    );
});

bot.help((ctx) => {
    ctx.reply(
        'Multi-Platform Media Downloader Bot\n\n' +
        'Cara penggunaan:\n' +
        '- Kirim link dari platform yang didukung\n' +
        '- Tunggu beberapa saat hingga bot memproses dan mengirimkan medianya\n\n' +
        'Platform yang didukung:\n' +
        getSupportedPlatformsList() + '\n\n' +
        'Perintah:\n' +
        '/start - Memulai bot\n' +
        '/help - Menampilkan bantuan\n' +
        '/platforms - Menampilkan daftar platform yang didukung\n\n' +
        'Note: Pastikan link yang kamu kirim valid dan konten tidak diprivat.'
    );
});

bot.command('platforms', (ctx) => {
    ctx.reply(
        'Platform yang didukung:\n\n' +
        getSupportedPlatformsList()
    );
});

bot.on('text', async (ctx) => {
    const message = ctx.message.text;
    
    if (message.startsWith('/')) return;
    
    if (message.includes('http') || message.includes('www.')) {
        const platform = identifyPlatform(message);
        
        if (platform) {
            try {
                ctx.reply(`Sedang memproses link dari ${platform}...`);
                const mediaInfo = await downloadMedia(message);
                await saveVideo(mediaInfo.platform, mediaInfo.mediaUrl, mediaInfo.thumbnail, message);
                await sendMediaToUser(ctx, mediaInfo);
            } catch (error) {
                console.error(`Error processing ${platform} link:`, error);
                ctx.reply(`Terjadi kesalahan saat memproses media dari ${platform}. Pastikan URL yang kamu kirim valid dan konten tidak diprivat.`);
            }
        } else {
            ctx.reply('Platform ini mungkin belum didukung. Gunakan /platforms untuk melihat daftar platform yang didukung.');
        }
    } else {
        ctx.reply('Tolong kirimkan link dari platform yang didukung. Gunakan /help untuk informasi lebih lanjut.');
    }
});

bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('Terjadi kesalahan pada bot. Silakan coba lagi nanti.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const app = express();
app.get('/', (req, res) => {
    res.send('Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

bot.launch()
    .then(() => console.log('Bot Telegram berjalan...'))
    .catch((err) => console.error('Error running bot:', err));

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});