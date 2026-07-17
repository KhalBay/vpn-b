const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3002;

// PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// 3X-UI axios instance (игнорируем самоподписанный сертификат)
const xuiAxios = axios.create({
    baseURL: process.env.XUI_BASE_URL,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

// Сессия 3X-UI
const XUI_API_TOKEN = process.env.XUI_API_TOKEN;

console.log('ТОКЕН ЕСТЬ:', XUI_API_TOKEN ? 'ДА' : 'НЕТ');
console.log('ДЛИНА ТОКЕНА:', XUI_API_TOKEN ? XUI_API_TOKEN.length : 0);

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'vpn-secret';
const INBOUND_ID = 7;
const SERVER_IP = '85.137.95.163';
const SERVER_PORT = 443;

// Инициализация БД
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
                balance DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS vpn_clients (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                client_type VARCHAR(20) DEFAULT 'demo' CHECK (client_type IN ('demo', 'paid')),
                xui_email VARCHAR(100),
                xui_uuid VARCHAR(255),
                xui_password VARCHAR(255),
                xui_subscription_id VARCHAR(255),
                xui_inbound_id INTEGER DEFAULT 7,
                traffic_limit_bytes BIGINT DEFAULT 0,
                traffic_used_bytes BIGINT DEFAULT 0,
                expiry_date TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(10,2),
                payment_type VARCHAR(50) DEFAULT 'manual',
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Таблицы созданы или уже существуют');
    } catch (err) {
        console.error('Ошибка при создании таблиц:', err);
    }
};
initDB();

// Получить список клиентов из 3X-UI
const getXUIClients = async () => {
    try {
        console.log('[getXUIClients] Запрос клиентов...');
        const response = await xuiAxios.get(`/panel/api/inbounds/get/${INBOUND_ID}`, {
            headers: { Authorization: `Bearer ${XUI_API_TOKEN}` },
        });
        console.log('[getXUIClients] Статус:', response.status, 'success:', response.data.success);
        if (response.data.success && response.data.obj) {
            const inbound = response.data.obj;
            // Клиенты в clientStats
            const clients = inbound.clientStats || [];
            console.log('[getXUIClients] Получено клиентов:', clients.length);
            return clients;
        }
        console.error('[getXUIClients] Ошибка ответа:', JSON.stringify(response.data).substring(0, 200));
        return [];
    } catch (err) {
        console.error('[getXUIClients] Ошибка:', err.message);
        return [];
    }
};

// Добавить клиента в 3X-UI
const addXUIClient = async (email, uuid, password, trafficLimitBytes, expiryDate) => {
    console.log('[addXUIClient] Добавляем:', email);

    const newClient = {
        id: uuid,
        flow: 'xtls-rprx-vision',
        email: email,
        limitIp: 1,
        totalGB: Math.floor(trafficLimitBytes / (1024 * 1024 * 1024)),
        expiryTime: expiryDate ? Math.floor(new Date(expiryDate).getTime()) : 0,
        enable: true,
        tgId: '',
        subId: '',
        reset: 0,
    };

    try {
        const response = await xuiAxios.post(
            `/panel/api/inbounds/addClient`,
            {
                id: INBOUND_ID,
                settings: JSON.stringify({ clients: [newClient] }),
            },
            { headers: { Authorization: `Bearer ${XUI_API_TOKEN}` } }
        );
        console.log('[addXUIClient] Ответ:', response.status, JSON.stringify(response.data).substring(0, 300));

        if (response.data.success) {
            const created = newClient;
            console.log('[addXUIClient] Клиент создан:', email);
            return created;
        }
        console.error('[addXUIClient] Ошибка:', response.data);
        return null;
    } catch (err) {
        console.error('[addXUIClient] Ошибка API:', err.message);
        return null;
    }
};

// Удалить клиента из 3X-UI
const removeXUIClient = async (email) => {
    console.log('[removeXUIClient] Удаляем:', email);
    try {
        const response = await xuiAxios.post(
            `/panel/api/inbounds/delClient`,
            {
                id: INBOUND_ID,
                email: email,
            },
            { headers: { Authorization: `Bearer ${XUI_API_TOKEN}` } }
        );
        console.log('[removeXUIClient] Ответ:', response.status, response.data.success);
        return response.data.success;
    } catch (err) {
        console.error('[removeXUIClient] Ошибка:', err.message);
        return false;
    }
};

// Обновить трафик/дату клиента
const updateXUIClient = async (email, updates) => {
    console.log('[updateXUIClient] Обновляем:', email);

    const updateData = {
        id: INBOUND_ID,
        email: email,
    };

    if (updates.totalGB !== undefined) updateData.totalGB = updates.totalGB;
    if (updates.expiryTime !== undefined) updateData.expiryTime = updates.expiryTime;
    if (updates.up !== undefined) updateData.up = updates.up;
    if (updates.down !== undefined) updateData.down = updates.down;
    if (updates.enable !== undefined) updateData.enable = updates.enable;

    try {
        const response = await xuiAxios.post(
            `/panel/api/inbounds/updateClient`,
            updateData,
            { headers: { Authorization: `Bearer ${XUI_API_TOKEN}` } }
        );
        console.log('[updateXUIClient] Ответ:', response.status, response.data.success);
        return response.data.success ? updates : null;
    } catch (err) {
        console.error('[updateXUIClient] Ошибка:', err.message);
        return null;
    }
};
// Генерация ссылки для подключения
const generateVlessLink = (email, uuid) => {
    // VLESS Reality link format
    const serverName = 'www.amd.com';
    const publicKey = '5a6kt1iCtKoio9VzYo3sgvvLmmbOEE6ygqpv3p6ZOD8';
    const shortId = '736a';
    const flow = 'xtls-rprx-vision';

    // vless://uuid@ip:port?type=tcp&security=reality&pbk=publicKey&fp=chrome&sni=serverName&sid=shortId&flow=flow&encryption=none#name
    const params = new URLSearchParams({
        type: 'tcp',
        security: 'reality',
        pbk: publicKey,
        fp: 'chrome',
        sni: serverName,
        sid: shortId,
        flow: flow,
        encryption: 'none',
    });

    return `vless://${uuid}@${SERVER_IP}:${SERVER_PORT}?${params.toString()}#VPN-${email}`;
};

// Middleware аутентификации
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Токен обязателен' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Неверный токен' });
        req.user = user;
        next();
    });
};

// ============= ЭНДПОИНТЫ =============

// Регистрация
app.post('/auth/register', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
        return res.status(400).json({ message: 'Телефон и пароль обязательны' });
    }

    // Простой формат телефона (без +)
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    try {
        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ message: 'Пользователь с таким номером уже существует' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (phone, password_hash) VALUES ($1, $2) RETURNING id, phone, role, created_at',
            [cleanPhone, passwordHash]
        );

        res.status(201).json({ message: 'Регистрация успешна', user: result.rows[0] });
    } catch (err) {
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Авторизация
app.post('/auth/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
        return res.status(400).json({ message: 'Телефон и пароль обязательны' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    try {
        const result = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ message: 'Неверный телефон или пароль' });

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ message: 'Неверный телефон или пароль' });

        const token = jwt.sign(
            { userId: user.id, phone: user.phone, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({ token, user: { id: user.id, phone: user.phone, role: user.role } });
    } catch (err) {
        console.error('Ошибка авторизации:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Получить демо-доступ (7 дней, 500 МБ)
app.post('/vpn/demo', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        // Проверяем, нет ли уже демо
        const existingDemo = await pool.query(
            'SELECT * FROM vpn_clients WHERE user_id = $1 AND client_type = $2 AND is_active = true',
            [userId, 'demo']
        );
        if (existingDemo.rows.length > 0) {
            return res.status(400).json({ message: 'У вас уже есть активный демо-доступ' });
        }

        const email = `demo_${userId}_${Date.now()}`;
        const uuid = require('crypto').randomUUID();
        const password = require('crypto').randomBytes(8).toString('hex');

        const trafficBytes = parseFloat(process.env.DEMO_TRAFFIC_GB || 0.5) * 1024 * 1024 * 1024;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.DEMO_DAYS || 7));

        const xuiClient = await addXUIClient(email, uuid, password, trafficBytes, expiryDate);
        if (!xuiClient) {
            return res.status(500).json({ message: 'Ошибка создания клиента VPN' });
        }

        // Сохраняем в БД
        await pool.query(
            `INSERT INTO vpn_clients (user_id, client_type, xui_email, xui_uuid, xui_password, xui_inbound_id, traffic_limit_bytes, expiry_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
            [userId, 'demo', email, uuid, password, INBOUND_ID, trafficBytes, expiryDate]
        );

        const link = generateVlessLink(email, uuid);

        res.json({
            message: 'Демо-доступ создан',
            link,
            expiry: expiryDate,
            traffic_limit: `${process.env.DEMO_TRAFFIC_GB} ГБ`,
            days: process.env.DEMO_DAYS,
        });
    } catch (err) {
        console.error('Ошибка создания демо:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Получить статус своего VPN
app.get('/vpn/status', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        const clients = await pool.query(
            'SELECT * FROM vpn_clients WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC',
            [userId]
        );

        // Получаем актуальные данные из 3X-UI
        const xuiClients = await getXUIClients();

        const result = clients.rows.map(client => {
            const xuiData = xuiClients.find(c => c.email === client.xui_email);
            return {
                ...client,
                link: generateVlessLink(client.xui_email, client.xui_uuid),
                traffic_used_bytes: xuiData?.up || 0 + (xuiData?.down || 0),
                is_online: xuiData?.enable || false,
            };
        });

        res.json(result);
    } catch (err) {
        console.error('Ошибка статуса:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Продлить VPN (сбросить трафик + новую дату)
app.post('/vpn/renew', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { clientId } = req.body;

    if (!clientId) {
        return res.status(400).json({ message: 'Укажите clientId' });
    }

    try {
        const client = await pool.query(
            'SELECT * FROM vpn_clients WHERE id = $1 AND user_id = $2',
            [clientId, userId]
        );
        if (client.rows.length === 0) {
            return res.status(404).json({ message: 'VPN-клиент не найден' });
        }

        const c = client.rows[0];
        const newTrafficBytes = parseInt(process.env.PAID_TRAFFIC_GB || 50) * 1024 * 1024 * 1024;
        const newExpiry = new Date();
        newExpiry.setDate(newExpiry.getDate() + parseInt(process.env.PAID_DAYS || 30));

        // Обновляем в 3X-UI
        const updated = await updateXUIClient(c.xui_email, {
            totalGB: Math.floor(newTrafficBytes / (1024 * 1024 * 1024)),
            expiryTime: Math.floor(newExpiry.getTime()),
            up: 0,
            down: 0,
        });

        if (!updated) {
            return res.status(500).json({ message: 'Ошибка обновления VPN' });
        }

        // Обновляем в БД
        await pool.query(
            `UPDATE vpn_clients SET traffic_limit_bytes = $1, expiry_date = $2 WHERE id = $3`,
            [newTrafficBytes, newExpiry, clientId]
        );

        res.json({
            message: 'VPN продлён',
            expiry: newExpiry,
            traffic_limit: `${process.env.PAID_TRAFFIC_GB} ГБ`,
        });
    } catch (err) {
        console.error('Ошибка продления:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Купить VPN (создать платного клиента)
app.post('/vpn/buy', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        // Проверяем демо (если есть - деактивируем)
        const demoClient = await pool.query(
            'SELECT * FROM vpn_clients WHERE user_id = $1 AND client_type = $2 AND is_active = true',
            [userId, 'demo']
        );
        if (demoClient.rows.length > 0) {
            await removeXUIClient(demoClient.rows[0].xui_email);
            await pool.query('UPDATE vpn_clients SET is_active = false WHERE id = $1', [demoClient.rows[0].id]);
        }

        const email = `paid_${userId}_${Date.now()}`;
        const uuid = require('crypto').randomUUID();
        const password = require('crypto').randomBytes(8).toString('hex');

        const trafficBytes = parseInt(process.env.PAID_TRAFFIC_GB || 50) * 1024 * 1024 * 1024;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.PAID_DAYS || 30));

        const xuiClient = await addXUIClient(email, uuid, password, trafficBytes, expiryDate);
        if (!xuiClient) {
            return res.status(500).json({ message: 'Ошибка создания VPN-клиента' });
        }

        // Сохраняем в БД
        await pool.query(
            `INSERT INTO vpn_clients (user_id, client_type, xui_email, xui_uuid, xui_password, xui_inbound_id, traffic_limit_bytes, expiry_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
            [userId, 'paid', email, uuid, password, INBOUND_ID, trafficBytes, expiryDate]
        );

        // Создаём платёж
        await pool.query(
            `INSERT INTO payments (user_id, amount, status) VALUES ($1, $2, 'completed')`,
            [userId, process.env.PAID_PRICE || 150]
        );

        const link = generateVlessLink(email, uuid);

        res.json({
            message: 'VPN куплен',
            link,
            expiry: expiryDate,
            traffic_limit: `${process.env.PAID_TRAFFIC_GB} ГБ`,
            price: `${process.env.PAID_PRICE} ₽`,
        });
    } catch (err) {
        console.error('Ошибка покупки:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Тестовые эндпоинты
app.get('/test', (req, res) => res.json({ message: 'VPN API работает!' }));

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK', message: 'БД подключена' });
    } catch (err) {
        res.status(500).json({ status: 'ERROR' });
    }
});

// Запуск
app.listen(port, async () => {
    console.log(`🚀 VPN сервер запущен на порту ${port}`);
});
