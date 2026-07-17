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

// 3X-UI axios instance
const xuiAxios = axios.create({
    baseURL: process.env.XUI_BASE_URL,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

const XUI_API_TOKEN = process.env.XUI_API_TOKEN;
console.log('ТОКЕН ЕСТЬ:', XUI_API_TOKEN ? 'ДА' : 'НЕТ');

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
                role VARCHAR(20) DEFAULT 'user',
                balance DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS vpn_clients (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                client_type VARCHAR(20) DEFAULT 'demo',
                xui_email VARCHAR(100),
                xui_uuid VARCHAR(255),
                xui_inbound_id INTEGER DEFAULT 7,
                traffic_limit_bytes BIGINT DEFAULT 0,
                expiry_date TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(10,2),
                payment_type VARCHAR(50) DEFAULT 'manual',
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Таблицы созданы');
    } catch (err) {
        console.error('Ошибка БД:', err);
    }
};
initDB();

// Получить клиентов из 3X-UI
const getXUIClients = async () => {
    try {
        const response = await xuiAxios.get(`/panel/api/inbounds/get/${INBOUND_ID}`, {
            headers: { Authorization: `Bearer ${XUI_API_TOKEN}` },
        });
        if (response.data.success && response.data.obj) {
            return response.data.obj.clientStats || [];
        }
        return [];
    } catch (err) {
        console.error('getXUIClients:', err.message);
        return [];
    }
};

// Добавить клиента в 3X-UI
const addXUIClient = async (email, uuid, trafficLimitBytes, expiryDate, group = 'users') => {
    console.log('addXUIClient:', email, 'group:', group);

    const body = {
        client: {
            email: email,
            totalGB: Math.floor(trafficLimitBytes / (1024 * 1024 * 1024)),
            expiryTime: expiryDate ? Math.floor(new Date(expiryDate).getTime()) : 0,
            limitIp: 1,
            enable: true,
            flow: 'xtls-rprx-vision',
            subId: '',
            tgId: 0,
            group: group,
        },
        inboundIds: [INBOUND_ID],
    };

    try {
        const response = await xuiAxios.post('/panel/api/clients/add', body, {
            headers: { Authorization: `Bearer ${XUI_API_TOKEN}` },
        });
        console.log('addXUIClient success:', response.data.success);
        if (response.data.success) return { email, enable: true };
        console.error('addXUIClient error:', JSON.stringify(response.data));
        return null;
    } catch (err) {
        console.error('addXUIClient:', err.message);
        return null;
    }
};

// Удалить клиента
const removeXUIClient = async (email) => {
    try {
        const response = await xuiAxios.post(`/panel/api/clients/del/${email}`, {}, {
            headers: { Authorization: `Bearer ${XUI_API_TOKEN}` },
        });
        return response.data.success;
    } catch (err) {
        console.error('removeXUIClient:', err.message);
        return false;
    }
};

// Обновить клиента
const updateXUIClient = async (email, updates) => {
    try {
        const response = await xuiAxios.post(`/panel/api/clients/update/${email}`, updates, {
            headers: { Authorization: `Bearer ${XUI_API_TOKEN}` },
        });
        return response.data.success ? updates : null;
    } catch (err) {
        console.error('updateXUIClient:', err.message);
        return null;
    }
};

// Генерация VLESS ссылки
const generateVlessLink = (email, uuid) => {
    const params = new URLSearchParams({
        type: 'tcp',
        security: 'reality',
        pbk: '5a6kt1iCtKoio9VzYo3sgvvLmmbOEE6ygqpv3p6ZOD8',
        fp: 'chrome',
        sni: 'www.amd.com',
        sid: '736a',
        flow: 'xtls-rprx-vision',
        encryption: 'none',
    });
    return `vless://${uuid}@${SERVER_IP}:${SERVER_PORT}?${params.toString()}#VPN-${email}`;
};

// Middleware
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

// Регистрация
app.post('/auth/register', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ message: 'Телефон и пароль обязательны' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    try {
        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
        if (existing.rows.length > 0) return res.status(400).json({ message: 'Пользователь уже существует' });
        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (phone, password_hash) VALUES ($1, $2) RETURNING id, phone, role, created_at',
            [cleanPhone, passwordHash]
        );
        res.status(201).json({ message: 'Регистрация успешна', user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Авторизация
app.post('/auth/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ message: 'Телефон и пароль обязательны' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    try {
        const result = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ message: 'Неверный телефон или пароль' });
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ message: 'Неверный телефон или пароль' });
        const token = jwt.sign({ userId: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, phone: user.phone, role: user.role } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Демо-доступ
app.post('/vpn/demo', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const existingDemo = await pool.query(
            'SELECT * FROM vpn_clients WHERE user_id = $1 AND client_type = $2 AND is_active = true',
            [userId, 'demo']
        );
        if (existingDemo.rows.length > 0) return res.status(400).json({ message: 'У вас уже есть активный демо-доступ' });

        const email = `demo_${userId}_${Date.now()}`;
        const uuid = require('crypto').randomUUID();
        const trafficBytes = parseFloat(process.env.DEMO_TRAFFIC_GB || 0.5) * 1024 * 1024 * 1024;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.DEMO_DAYS || 7));

        const xuiClient = await addXUIClient(email, uuid, trafficBytes, expiryDate, 'demo');
        if (!xuiClient) return res.status(500).json({ message: 'Ошибка создания клиента VPN' });

        await pool.query(
            `INSERT INTO vpn_clients (user_id, client_type, xui_email, xui_uuid, xui_inbound_id, traffic_limit_bytes, expiry_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [userId, 'demo', email, uuid, INBOUND_ID, trafficBytes, expiryDate]
        );

        const link = generateVlessLink(email, uuid);
        res.json({ message: 'Демо-доступ создан', link, expiry: expiryDate, traffic_limit: `${process.env.DEMO_TRAFFIC_GB} ГБ`, days: process.env.DEMO_DAYS });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Статус VPN
app.get('/vpn/status', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const clients = await pool.query('SELECT * FROM vpn_clients WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC', [userId]);
        const xuiClients = await getXUIClients();
        const result = clients.rows.map(client => {
            const xuiData = xuiClients.find(c => c.email === client.xui_email);
            return { ...client, link: generateVlessLink(client.xui_email, client.xui_uuid), is_online: xuiData?.enable || false };
        });
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Продлить VPN
app.post('/vpn/renew', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ message: 'Укажите clientId' });
    try {
        const client = await pool.query('SELECT * FROM vpn_clients WHERE id = $1 AND user_id = $2', [clientId, userId]);
        if (client.rows.length === 0) return res.status(404).json({ message: 'VPN-клиент не найден' });
        const c = client.rows[0];
        const newTrafficBytes = parseInt(process.env.PAID_TRAFFIC_GB || 50) * 1024 * 1024 * 1024;
        const newExpiry = new Date();
        newExpiry.setDate(newExpiry.getDate() + parseInt(process.env.PAID_DAYS || 30));
        const updated = await updateXUIClient(c.xui_email, { totalGB: Math.floor(newTrafficBytes / (1024 * 1024 * 1024)), expiryTime: Math.floor(newExpiry.getTime()), up: 0, down: 0 });
        if (!updated) return res.status(500).json({ message: 'Ошибка обновления VPN' });
        await pool.query('UPDATE vpn_clients SET traffic_limit_bytes = $1, expiry_date = $2 WHERE id = $3', [newTrafficBytes, newExpiry, clientId]);
        res.json({ message: 'VPN продлён', expiry: newExpiry, traffic_limit: `${process.env.PAID_TRAFFIC_GB} ГБ` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Купить VPN
app.post('/vpn/buy', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const demoClient = await pool.query('SELECT * FROM vpn_clients WHERE user_id = $1 AND client_type = $2 AND is_active = true', [userId, 'demo']);
        if (demoClient.rows.length > 0) {
            await removeXUIClient(demoClient.rows[0].xui_email);
            await pool.query('UPDATE vpn_clients SET is_active = false WHERE id = $1', [demoClient.rows[0].id]);
        }
        const email = `paid_${userId}_${Date.now()}`;
        const uuid = require('crypto').randomUUID();
        const trafficBytes = parseInt(process.env.PAID_TRAFFIC_GB || 50) * 1024 * 1024 * 1024;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + parseInt(process.env.PAID_DAYS || 30));
        const xuiClient = await addXUIClient(email, uuid, trafficBytes, expiryDate, 'users');
        if (!xuiClient) return res.status(500).json({ message: 'Ошибка создания VPN-клиента' });
        await pool.query(
            `INSERT INTO vpn_clients (user_id, client_type, xui_email, xui_uuid, xui_inbound_id, traffic_limit_bytes, expiry_date, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [userId, 'paid', email, uuid, INBOUND_ID, trafficBytes, expiryDate]
        );
        await pool.query('INSERT INTO payments (user_id, amount, status) VALUES ($1, $2, $3)', [userId, process.env.PAID_PRICE || 150, 'completed']);
        const link = generateVlessLink(email, uuid);
        res.json({ message: 'VPN куплен', link, expiry: expiryDate, traffic_limit: `${process.env.PAID_TRAFFIC_GB} ГБ`, price: `${process.env.PAID_PRICE} ₽` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// Тест
app.get('/test', (req, res) => res.json({ message: 'VPN API работает!' }));
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK' });
    } catch (err) {
        res.status(500).json({ status: 'ERROR' });
    }
});

app.listen(port, () => console.log(`🚀 VPN сервер на порту ${port}`));