const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
require('dotenv').config()

// Функция генерации PDF
const PDFDocument = require('pdfkit');
const path = require('path');

// Путь к шрифту с поддержкой кириллицы
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const nodemailer = require('nodemailer');

// Настройка почты
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Функция генерации PDF
const generatePDF = (questionnaire) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const buffers = [];

        doc.on('data', buffer => buffers.push(buffer));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // Регистрируем шрифт
        doc.registerFont('DejaVu', FONT_PATH);

        // Заголовок
        doc.font('DejaVu', 18).text('ЗАЯВКА НА МАТЕРИАЛЫ', { align: 'center' });
        doc.moveDown(0.5);

        // Информация о заявке
        doc.font('DejaVu', 12);
        doc.text(`Тип работ: ${questionnaire.work_type}`);
        doc.text(`Адрес: ${questionnaire.address}`);
        doc.text(`Телефон: ${questionnaire.phone || '—'}`);
        doc.text(`Дата: ${new Date(questionnaire.created_at).toLocaleString('ru-RU')}`);
        doc.moveDown();

        // Таблица материалов
        doc.font('DejaVu', 14).text('МАТЕРИАЛЫ:', { underline: true });
        doc.moveDown(0.5);

        // Заголовки таблицы
        doc.font('DejaVu', 10);
        const tableTop = doc.y;
        doc.text('№', 50, tableTop);
        doc.text('Наименование', 80, tableTop, { width: 260 });
        doc.text('Кол-во', 350, tableTop, { width: 60, align: 'right' });
        doc.text('Ед.', 420, tableTop, { width: 40, align: 'right' });
        doc.text('Артикул', 470, tableTop, { width: 60, align: 'right' });

        // Линия
        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

        // Данные таблицы
        doc.font('DejaVu', 10);
        let y = tableTop + 20;
        questionnaire.materials.forEach((material, index) => {
            if (y > 750) {
                doc.addPage();
                y = 50;
            }
            doc.text(`${index + 1}`, 50, y);
            doc.text(material.name, 80, y, { width: 260 });
            doc.text(`${material.quantity}`, 350, y, { width: 60, align: 'right' });
            doc.text(material.unit, 420, y, { width: 40, align: 'right' });
            doc.text(`${material.article}`, 470, y, { width: 60, align: 'right' });
            y += 18;
        });

        doc.moveDown();
        doc.font('DejaVu', 8).text(`Создано: ${new Date().toLocaleString('ru-RU')}`, { align: 'right' });

        doc.end();
    });
};

// Функция отправки на почту
const sendEmail = async (pdfBuffer, questionnaire) => {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `Новая заявка — ${questionnaire.work_type} (${questionnaire.address})`,
        text: `Поступила новая заявка.\n\nТип работ: ${questionnaire.work_type}\nАдрес: ${questionnaire.address}\nТелефон: ${questionnaire.phone || 'не указан'}\nМатериалов: ${questionnaire.materials.length} шт.`,
        attachments: [
            {
                filename: `zayavka_${questionnaire.id}.pdf`,
                content: pdfBuffer,
            },
        ],
    };

    return transporter.sendMail(mailOptions);
};

const app = express()
const port = process.env.PORT || 3001

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false,
    },
})

app.use(cors())
app.use(express.json())

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

// Middleware для аутентификации
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]

    if (!token) {
        return res.status(401).json({ message: 'Токен обязателен' })
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Неверный токен' })
        }
        req.user = user
        next()
    })
}

// Middleware для проверки роли администратора
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Доступ запрещен. Требуются права администратора' })
    }
    next()
}

// Регистрация
app.post('/register', async (req, res) => {
    const { username, password, role } = req.body

    if (!username || !password) {
        return res.status(400).json({ message: 'Логин и пароль обязательны' })
    }

    const userRole = role || 'brigadier'

    if (!['admin', 'brigadier'].includes(userRole)) {
        return res.status(400).json({ message: 'Неверная роль. Допустимые роли: admin, brigadier' })
    }

    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE username = $1', [username])
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ message: 'Пользователь с таким логином уже существует' })
        }

        const hashedPassword = await bcrypt.hash(password, 10)

        const newUser = await pool.query(
            'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role',
            [username, hashedPassword, userRole]
        )

        res.status(201).json({
            message: 'Пользователь успешно создан',
            user: newUser.rows[0]
        })
    } catch (err) {
        console.error('Ошибка при регистрации:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Авторизация
app.post('/login', async (req, res) => {
    const { username, password } = req.body

    if (!username || !password) {
        return res.status(400).json({ message: 'Логин и пароль обязательны' })
    }

    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username])
        const user = userQuery.rows[0]

        if (!user) {
            return res.status(401).json({ message: 'Неверный логин или пароль' })
        }

        const validPassword = await bcrypt.compare(password, user.password)
        if (!validPassword) {
            return res.status(401).json({ message: 'Неверный логин или пароль' })
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '168y' }
        )

        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role }
        })
    } catch (err) {
        console.error('Ошибка при авторизации:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Создание анкеты с материалами
app.post('/questionnaires', authenticateToken, async (req, res) => {
    const { work_type, address, phone, materials } = req.body;
    const userId = req.user.userId;

    if (!work_type || !address || !materials || !Array.isArray(materials) || materials.length === 0) {
        return res.status(400).json({ message: 'Тип работы, адрес и хотя бы один материал обязательны' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const questionnaireResult = await client.query(
            `INSERT INTO questionnaires (work_type, address, phone, created_by) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [work_type, address, phone || null, userId]
        );
        const questionnaire = questionnaireResult.rows[0];

        const materialPromises = materials.map(material =>
            client.query(
                `INSERT INTO materials (questionnaire_id, name, quantity, unit, article) 
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [questionnaire.id, material.name, material.quantity, material.unit, material.article]
            )
        );
        const materialResults = await Promise.all(materialPromises);
        const insertedMaterials = materialResults.map(r => r.rows[0]);

        await client.query('COMMIT');

        // Отправляем PDF на почту (не блокируем ответ)
        const fullQuestionnaire = {
            ...questionnaire,
            materials: insertedMaterials,
        };

        generatePDF(fullQuestionnaire)
            .then(pdfBuffer => sendEmail(pdfBuffer, fullQuestionnaire))
            .catch(err => console.error('Ошибка отправки на почту:', err));

        res.status(201).json({
            ...questionnaire,
            materials: insertedMaterials,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка при создании анкеты:', err);
        res.status(500).json({ message: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// Получение всех анкет с материалами
app.get('/questionnaires', authenticateToken, async (req, res) => {
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        let query = `
            SELECT q.*, u.username as creator_name
            FROM questionnaires q 
            JOIN users u ON q.created_by = u.id
        `
        let params = []

        if (userRole !== 'admin') {
            query += ' WHERE q.created_by = $1'
            params.push(userId)
        }

        if (req.query.status) {
            query += params.length > 0 ? ' AND' : ' WHERE'
            params.push(req.query.status)
            query += ` q.status = $${params.length}`
        }

        query += ' ORDER BY q.created_at DESC'

        const questionnairesResult = await pool.query(query, params)
        const questionnaires = questionnairesResult.rows

        // Для каждой анкеты получаем материалы
        const result = await Promise.all(
            questionnaires.map(async (q) => {
                const materialsResult = await pool.query(
                    'SELECT * FROM materials WHERE questionnaire_id = $1 ORDER BY id',
                    [q.id]
                )
                return {
                    ...q,
                    materials: materialsResult.rows
                }
            })
        )

        res.json(result)
    } catch (err) {
        console.error('Ошибка при получении анкет:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Получение одной анкеты
app.get('/questionnaires/:id', authenticateToken, async (req, res) => {
    const questionnaireId = req.params.id
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        const questionnaireResult = await pool.query(
            `SELECT q.*, u.username as creator_name 
             FROM questionnaires q JOIN users u ON q.created_by = u.id 
             WHERE q.id = $1`,
            [questionnaireId]
        )

        if (questionnaireResult.rows.length === 0) {
            return res.status(404).json({ message: 'Анкета не найдена' })
        }

        const questionnaire = questionnaireResult.rows[0]

        if (userRole !== 'admin' && questionnaire.created_by !== userId) {
            return res.status(403).json({ message: 'Доступ запрещен' })
        }

        const materialsResult = await pool.query(
            'SELECT * FROM materials WHERE questionnaire_id = $1 ORDER BY id',
            [questionnaireId]
        )

        res.json({
            ...questionnaire,
            materials: materialsResult.rows
        })
    } catch (err) {
        console.error('Ошибка при получении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Обновление анкеты и материалов
app.put('/questionnaires/:id', authenticateToken, async (req, res) => {
    const questionnaireId = req.params.id
    const userId = req.user.userId
    const userRole = req.user.role
    const { work_type, address, phone, status, materials } = req.body

    const client = await pool.connect()

    try {
        // Проверяем существование и доступ
        const checkResult = await client.query('SELECT * FROM questionnaires WHERE id = $1', [questionnaireId])
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ message: 'Анкета не найдена' })
        }
        if (userRole !== 'admin' && checkResult.rows[0].created_by !== userId) {
            return res.status(403).json({ message: 'Доступ запрещен' })
        }

        await client.query('BEGIN')

        // Обновляем анкету
        const updateResult = await client.query(
            `UPDATE questionnaires 
             SET work_type = COALESCE($1, work_type),
                 address = COALESCE($2, address),
                 phone = COALESCE($3, phone),
                 status = COALESCE($4, status),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [work_type, address, phone, status, questionnaireId]
        )

        // Если переданы материалы — удаляем старые и вставляем новые
        if (materials && Array.isArray(materials)) {
            await client.query('DELETE FROM materials WHERE questionnaire_id = $1', [questionnaireId])

            const materialPromises = materials.map(material =>
                client.query(
                    `INSERT INTO materials (questionnaire_id, name, quantity, unit, article) 
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [questionnaireId, material.name, material.quantity, material.unit, material.article]
                )
            )
            await Promise.all(materialPromises)
        }

        await client.query('COMMIT')

        // Возвращаем обновлённую анкету с материалами
        const materialsResult = await client.query(
            'SELECT * FROM materials WHERE questionnaire_id = $1 ORDER BY id',
            [questionnaireId]
        )

        res.json({
            ...updateResult.rows[0],
            materials: materialsResult.rows
        })
    } catch (err) {
        await client.query('ROLLBACK')
        console.error('Ошибка при обновлении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    } finally {
        client.release()
    }
})

// Удаление анкеты
app.delete('/questionnaires/:id', authenticateToken, async (req, res) => {
    const questionnaireId = req.params.id
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        const checkResult = await pool.query('SELECT * FROM questionnaires WHERE id = $1', [questionnaireId])
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ message: 'Анкета не найдена' })
        }
        if (userRole !== 'admin' && checkResult.rows[0].created_by !== userId) {
            return res.status(403).json({ message: 'Доступ запрещен' })
        }

        await pool.query('DELETE FROM questionnaires WHERE id = $1', [questionnaireId])
        res.json({ message: 'Анкета успешно удалена' })
    } catch (err) {
        console.error('Ошибка при удалении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Список пользователей (админ)
app.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await pool.query(
            'SELECT id, username, role, created_at FROM users ORDER BY created_at DESC'
        )
        res.json(users.rows)
    } catch (err) {
        console.error('Ошибка при получении пользователей:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Изменение роли (админ)
app.put('/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    const userId = req.params.id
    const { role } = req.body

    if (!role || !['admin', 'brigadier'].includes(role)) {
        return res.status(400).json({ message: 'Укажите корректную роль: admin или brigadier' })
    }

    try {
        const updatedUser = await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role',
            [role, userId]
        )

        if (updatedUser.rows.length === 0) {
            return res.status(404).json({ message: 'Пользователь не найден' })
        }

        res.json({ message: 'Роль пользователя обновлена', user: updatedUser.rows[0] })
    } catch (err) {
        console.error('Ошибка при изменении роли:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

app.get('/test', (req, res) => {
    res.json({ message: 'API работает!' })
})

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1')
        res.status(200).json({ status: 'OK', message: 'Подключение к БД работает' })
    } catch (err) {
        res.status(500).json({ status: 'ERROR', message: 'Ошибка подключения к БД' })
    }
})

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`)
})