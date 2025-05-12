const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const env = require('dotenv');

env.config();

const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

console.log('Бот запущен и слушает сообщения...');

const queue = [];
let isProcessing = false;

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  const text = isPrivate
    ? '👋 Отправьте ссылку на TikTok.'
    : '👋 Я готов обрабатывать ссылки на TikTok прямо в этой группе!';
  bot.sendMessage(chatId, text);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.startsWith('http')) return;

  const userRequest = {
    chatId,
    text,
    username: msg.from.username || msg.from.first_name,
    replyToMessageId: msg.message_id,
  };
  queue.push(userRequest);

  const position = queue.length;
  console.log(`Запрос от @${userRequest.username} добавлен в очередь [${position}]`);

  if (!isProcessing) {
    processQueue();
  }
});

async function processQueue() {
  if (queue.length === 0) {
    isProcessing = false;
    console.log('Очередь пуста. Ожидаем новых задач...');
    return;
  }

  isProcessing = true;
  const { chatId, text, username, replyToMessageId } = queue.shift();
  const currentQueueSize = queue.length;

  console.log(`Начал обработку для @${username} (осталось в очереди: ${currentQueueSize})`);
  console.log(`Ссылка: ${text}`);

  try {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(text)}`;
    const res = await axios.get(apiUrl);

    if (!res.data || res.data.code !== 0 || !res.data.data) {
      console.error('Неверный ответ от API:', res.data);
      await bot.sendMessage(chatId, '❌ Не удалось получить данные. Убедитесь, что ссылка корректна.', {
        reply_to_message_id: replyToMessageId,
      });
      return processQueue();
    }

    const data = res.data.data;

    // Обработка фото
    if (data.images && data.images.length > 0) {
      const images = data.images.slice(0, 10);
      console.log(`Найдено ${data.images.length} изображений. Отправка альбома из ${images.length} фото...`);

      const mediaGroup = images.map((url) => ({
        type: 'photo',
        media: url,
      }));

      try {
        await bot.sendMediaGroup(chatId, mediaGroup, {
          reply_to_message_id: replyToMessageId,
        });
        console.log(`Альбом успешно отправлен @${username}`);
      } catch (mediaErr) {
        console.error('Ошибка при отправке альбома:', mediaErr.message);
        await bot.sendMessage(chatId, '❌ Ошибка при отправке изображений.', {
          reply_to_message_id: replyToMessageId,
        });
      }

      return processQueue();
    }

    // Обработка видео
    const videoUrl = data.play;
    if (!videoUrl) {
      console.warn('Видео не найдено в ответе API.');
      await bot.sendMessage(chatId, '❌ Видео не найдено.', {
        reply_to_message_id: replyToMessageId,
      });
      return processQueue();
    }

    const response = await axios.get(videoUrl, { responseType: 'stream' });
    const filePath = path.join(__dirname, `video_${Date.now()}.mp4`);
    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    writer.on('finish', async () => {
      console.log(`Попытка отправить видео @${username}`);
      try {
        await bot.sendVideo(chatId, filePath, {
          reply_to_message_id: replyToMessageId,
        });
        console.log(`Видео успешно отправлено @${username}`);
      } catch (sendErr) {
        console.error('Ошибка при отправке видео:', sendErr.message);
        await bot.sendMessage(chatId, '❌ Не удалось отправить видео.', {
          reply_to_message_id: replyToMessageId,
        });
      } finally {
        fs.unlinkSync(filePath);
        console.log('Временный файл удалён.');
        processQueue();
      }
    });

    writer.on('error', async (writeErr) => {
      console.error('Ошибка при сохранении файла:', writeErr.message);
      await bot.sendMessage(chatId, '❌ Ошибка при сохранении видео.', {
        reply_to_message_id: replyToMessageId,
      });
      processQueue();
    });

  } catch (err) {
    console.error('Общая ошибка:', err.message);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке ссылки.', {
      reply_to_message_id: replyToMessageId,
    });
    processQueue();
  }
}
