const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
require('dotenv').config()

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

// Middleware для проверки доступа к анкете
const checkQuestionnaireAccess = async (req, res, next) => {
    const questionnaireId = req.params.id
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        const questionnaire = await pool.query('SELECT * FROM questionnaires WHERE id = $1', [questionnaireId])

        if (questionnaire.rows.length === 0) {
            return res.status(404).json({ message: 'Анкета не найдена' })
        }

        // Админы могут редактировать все анкеты
        if (userRole === 'admin') {
            req.questionnaire = questionnaire.rows[0]
            return next()
        }

        // Бригадиры могут редактировать только свои анкеты
        if (questionnaire.rows[0].created_by === userId) {
            req.questionnaire = questionnaire.rows[0]
            return next()
        }

        return res.status(403).json({ message: 'Доступ запрещен. Вы можете редактировать только свои анкеты' })
    } catch (err) {
        console.error('Ошибка при проверке доступа:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
}

// Регистрация пользователя
app.post('/register', async (req, res) => {
    const { username, password, role } = req.body

    if (!username || !password) {
        return res.status(400).json({ message: 'Логин и пароль обязательны' })
    }

    // По умолчанию роль "бригадир", если не указана другая
    const userRole = role || 'brigadier'

    if (!['admin', 'brigadier'].includes(userRole)) {
        return res.status(400).json({ message: 'Неверная роль. Допустимые роли: admin, brigadier' })
    }

    try {
        // Проверяем, существует ли уже такой пользователь
        const existingUser = await pool.query('SELECT * FROM users WHERE username = $1', [username])
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ message: 'Пользователь с таким логином уже существует' })
        }

        // Хешируем пароль
        const hashedPassword = await bcrypt.hash(password, 10)

        // Создаем пользователя
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
        // Ищем пользователя
        const userQuery = await pool.query('SELECT * FROM users WHERE username = $1', [username])
        const user = userQuery.rows[0]

        if (!user) {
            return res.status(401).json({ message: 'Неверный логин или пароль' })
        }

        // Проверяем пароль
        const validPassword = await bcrypt.compare(password, user.password)
        if (!validPassword) {
            return res.status(401).json({ message: 'Неверный логин или пароль' })
        }

        // Создаем JWT-токен
        const token = jwt.sign(
            {
                userId: user.id,
                username: user.username,
                role: user.role
            },
            JWT_SECRET,
            { expiresIn: '168h' } // Неделя
        )

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        })
    } catch (err) {
        console.error('Ошибка при авторизации:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Создание анкеты
app.post('/questionnaires', authenticateToken, async (req, res) => {
    const { materials, quantity, unit, article, status } = req.body
    const userId = req.user.userId

    if (!materials || quantity === undefined || !unit || article === undefined) {
        return res.status(400).json({
            message: 'Все поля обязательны: materials, quantity, unit, article'
        })
    }

    const questionnaireStatus = status || 'created'

    try {
        const newQuestionnaire = await pool.query(
            `INSERT INTO questionnaires (materials, quantity, unit, article, status, created_by) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING *`,
            [materials, quantity, unit, article, questionnaireStatus, userId]
        )

        res.status(201).json({
            message: 'Анкета успешно создана',
            questionnaire: newQuestionnaire.rows[0]
        })
    } catch (err) {
        console.error('Ошибка при создании анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Получение всех анкет (с фильтрацией)
app.get('/questionnaires', authenticateToken, async (req, res) => {
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        let query = 'SELECT q.*, u.username as creator_name FROM questionnaires q JOIN users u ON q.created_by = u.id'
        let params = []

        // Админ видит все анкеты, бригадир - только свои
        if (userRole !== 'admin') {
            query += ' WHERE q.created_by = $1'
            params.push(userId)
        }

        // Дополнительные фильтры
        if (req.query.status) {
            query += params.length > 0 ? ' AND' : ' WHERE'
            params.push(req.query.status)
            query += ` q.status = $${params.length}`
        }

        query += ' ORDER BY q.created_at DESC'

        const questionnaires = await pool.query(query, params)
        res.json(questionnaires.rows)
    } catch (err) {
        console.error('Ошибка при получении анкет:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Получение конкретной анкеты
app.get('/questionnaires/:id', authenticateToken, async (req, res) => {
    const questionnaireId = req.params.id
    const userId = req.user.userId
    const userRole = req.user.role

    try {
        const questionnaire = await pool.query(
            'SELECT q.*, u.username as creator_name FROM questionnaires q JOIN users u ON q.created_by = u.id WHERE q.id = $1',
            [questionnaireId]
        )

        if (questionnaire.rows.length === 0) {
            return res.status(404).json({ message: 'Анкета не найдена' })
        }

        const data = questionnaire.rows[0]

        // Проверка доступа: админ видит все, бригадир только свои
        if (userRole !== 'admin' && data.created_by !== userId) {
            return res.status(403).json({ message: 'Доступ запрещен' })
        }

        res.json(data)
    } catch (err) {
        console.error('Ошибка при получении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Обновление анкеты
app.put('/questionnaires/:id', authenticateToken, checkQuestionnaireAccess, async (req, res) => {
    const questionnaireId = req.params.id
    const { materials, quantity, unit, article, status } = req.body

    try {
        const currentQuestionnaire = req.questionnaire

        const updatedMaterials = materials || currentQuestionnaire.materials
        const updatedQuantity = quantity !== undefined ? quantity : currentQuestionnaire.quantity
        const updatedUnit = unit || currentQuestionnaire.unit
        const updatedArticle = article !== undefined ? article : currentQuestionnaire.article
        const updatedStatus = status || currentQuestionnaire.status

        const updatedQuestionnaire = await pool.query(
            `UPDATE questionnaires 
             SET materials = $1, quantity = $2, unit = $3, article = $4, status = $5, updated_at = CURRENT_TIMESTAMP
             WHERE id = $6 
             RETURNING *`,
            [updatedMaterials, updatedQuantity, updatedUnit, updatedArticle, updatedStatus, questionnaireId]
        )

        res.json({
            message: 'Анкета успешно обновлена',
            questionnaire: updatedQuestionnaire.rows[0]
        })
    } catch (err) {
        console.error('Ошибка при обновлении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Удаление анкеты
app.delete('/questionnaires/:id', authenticateToken, checkQuestionnaireAccess, async (req, res) => {
    const questionnaireId = req.params.id

    try {
        await pool.query('DELETE FROM questionnaires WHERE id = $1', [questionnaireId])
        res.json({ message: 'Анкета успешно удалена' })
    } catch (err) {
        console.error('Ошибка при удалении анкеты:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Получение списка пользователей (только для админов)
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

// Изменение роли пользователя (только для админов)
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

        res.json({
            message: 'Роль пользователя обновлена',
            user: updatedUser.rows[0]
        })
    } catch (err) {
        console.error('Ошибка при изменении роли:', err)
        res.status(500).json({ message: 'Ошибка сервера' })
    }
})

// Тестовые эндпоинты
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