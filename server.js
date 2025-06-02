const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// Middleware to handle JSON parsing
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// JSON syntax error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON syntax' });
  }
  next();
});

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'real_estate_db',
  password: process.env.PGPASSWORD || 'securepassword',
  port: process.env.PGPORT || 5432,
});

// Handle database connection errors
pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// Function to ensure admin user exists
async function ensureAdminUser() {
  try {
    const adminEmail = 'ezecharlesekene82@gmail.com';
    const adminPassword = 'charles2019@';
    
    // Check if admin exists
    const res = await pool.query('SELECT * FROM users WHERE email = $1', [adminEmail]);
    
    if (res.rows.length === 0) {
      // Create admin if doesn't exist
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await pool.query(
        `INSERT INTO users (name, email, password, role) 
         VALUES ($1, $2, $3, $4)`,
        ['Admin User', adminEmail, hashedPassword, 'admin']
      );
      console.log('Admin user created');
    } else {
      console.log('Admin user already exists');
    }
  } catch (err) {
    console.error('Error ensuring admin user:', err);
  }
}

// Create admin user on server start
ensureAdminUser();

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied, no token provided' });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
};

// Routes
app.get('/', (_, res) => res.send('Real Estate API is running'));

app.get('/test-db', async (_, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ time: result.rows[0] });
  } catch (err) {
    console.error('DB connection error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Property Endpoints
app.get('/api/properties', async (_, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.name AS agent_name
      FROM properties p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching properties:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.name AS agent_name, u.email AS agent_email
      FROM properties p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching property:', err);
    res.status(500).json({ error: err.message });
  }
});

// Auth Endpoints
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign({ 
      id: user.id, 
      email: user.email, 
      role: user.role 
    }, SECRET, { expiresIn: '1d' });
    
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        role: user.role 
      } 
    });
  } catch (err) {
    console.error('Sign-in error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name, email, role`,
      [name, email, hashedPassword, 'user']
    );
    
    const newUser = result.rows[0];
    const token = jwt.sign({ 
      id: newUser.id, 
      email: newUser.email, 
      role: newUser.role 
    }, SECRET, { expiresIn: '1d' });
    
    res.status(201).json({ 
      token, 
      user: newUser 
    });
  } catch (err) {
    console.error('Sign-up error:', err);
    res.status(err.code === '23505' ? 400 : 500).json({ 
      error: err.code === '23505' ? 'Email already in use' : err.message 
    });
  }
});

// Property Creation
app.post('/api/properties', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add properties' });
  }
  
  const { 
    title, 
    description, 
    price, 
    address, 
    city, 
    state, 
    zip_code, 
    latitude, 
    longitude, 
    type, 
    beds, 
    baths, 
    sqft, 
    images 
  } = req.body;
  
  try {
    // Validation
    const errors = [];
    if (!title) errors.push('Title is required');
    if (!description) errors.push('Description is required');
    if (!price) errors.push('Price is required');
    if (!address) errors.push('Address is required');
    if (!city) errors.push('City is required');
    if (!state) errors.push('State is required');
    if (!zip_code) errors.push('Zip code is required');
    if (latitude === undefined) errors.push('Latitude is required');
    if (longitude === undefined) errors.push('Longitude is required');
    if (!type) errors.push('Property type is required');
    if (beds === undefined) errors.push('Bedrooms count is required');
    if (baths === undefined) errors.push('Bathrooms count is required');
    if (sqft === undefined) errors.push('Square footage is required');
    
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }
    
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }
    
    const invalidImages = images.filter(img => 
      typeof img !== 'string' || !img.startsWith('data:image/')
    );
    
    if (invalidImages.length > 0) {
      return res.status(400).json({ error: 'All images must be valid base64 data URLs' });
    }
    
    // Stringify images for JSONB storage
    const imagesJson = JSON.stringify(images);
    
    // Insert property
    const result = await pool.query(
      `INSERT INTO properties (
        user_id, title, description, price, address, city, state, zip_code, 
        latitude, longitude, type, beds, baths, sqft, images
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb) 
      RETURNING *`,
      [
        req.user.id, 
        title, 
        description, 
        price, 
        address, 
        city, 
        state, 
        zip_code, 
        latitude, 
        longitude, 
        type, 
        beds, 
        baths, 
        sqft, 
        imagesJson
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding property:', err);
    
    // Handle constraint violations
    if (err.code === '23514') {
      const match = err.constraint.match(/properties_(.+)_check/);
      const field = match ? match[1] : 'data';
      return res.status(400).json({ error: `Invalid ${field} value` });
    }
    
    res.status(500).json({ error: 'Database operation failed' });
  }
});

// Property Update
app.put('/api/properties/:id', authenticateToken, async (req, res) => {
  const propertyId = req.params.id;
  const { 
    title, 
    description, 
    price, 
    address, 
    city, 
    state, 
    zip_code, 
    latitude, 
    longitude, 
    type, 
    beds, 
    baths, 
    sqft, 
    images 
  } = req.body;
  
  try {
    // Authorization
    if (req.user.role !== 'admin') {
      const propertyResult = await pool.query(
        'SELECT user_id FROM properties WHERE id = $1', 
        [propertyId]
      );
      
      if (propertyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Property not found' });
      }
      
      if (propertyResult.rows[0].user_id !== req.user.id) {
        return res.status(403).json({ error: 'Only the owner or admin can edit this property' });
      }
    }
    
    // Validation
    const errors = [];
    if (!title) errors.push('Title is required');
    if (!description) errors.push('Description is required');
    if (!price) errors.push('Price is required');
    if (!address) errors.push('Address is required');
    if (!city) errors.push('City is required');
    if (!state) errors.push('State is required');
    if (!zip_code) errors.push('Zip code is required');
    if (latitude === undefined) errors.push('Latitude is required');
    if (longitude === undefined) errors.push('Longitude is required');
    if (!type) errors.push('Property type is required');
    if (beds === undefined) errors.push('Bedrooms count is required');
    if (baths === undefined) errors.push('Bathrooms count is required');
    if (sqft === undefined) errors.push('Square footage is required');
    
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }
    
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }
    
    const invalidImages = images.filter(img => 
      typeof img !== 'string' || !img.startsWith('data:image/')
    );
    
    if (invalidImages.length > 0) {
      return res.status(400).json({ error: 'All images must be valid base64 data URLs' });
    }
    
    // Stringify images for JSONB storage
    const imagesJson = JSON.stringify(images);
    
    // Update property
    const result = await pool.query(
      `UPDATE properties SET 
        title = $1, 
        description = $2, 
        price = $3, 
        address = $4, 
        city = $5, 
        state = $6, 
        zip_code = $7, 
        latitude = $8, 
        longitude = $9, 
        type = $10, 
        beds = $11, 
        baths = $12, 
        sqft = $13, 
        images = $14::jsonb
      WHERE id = $15 
      RETURNING *`,
      [
        title, 
        description, 
        price, 
        address, 
        city, 
        state, 
        zip_code, 
        latitude, 
        longitude, 
        type, 
        beds, 
        baths, 
        sqft, 
        imagesJson, 
        propertyId
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating property:', err);
    
    // Handle constraint violations
    if (err.code === '23514') {
      const match = err.constraint.match(/properties_(.+)_check/);
      const field = match ? match[1] : 'data';
      return res.status(400).json({ error: `Invalid ${field} value` });
    }
    
    res.status(500).json({ error: 'Database operation failed' });
  }
});

// Delete property
app.delete('/api/properties/:id', authenticateToken, async (req, res) => {
  const propertyId = req.params.id;
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can delete properties' });
  }
  
  try {
    const result = await pool.query(
      'DELETE FROM properties WHERE id = $1 RETURNING *',
      [propertyId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    res.json({ 
      message: 'Property deleted successfully', 
      property: result.rows[0] 
    });
  } catch (err) {
    console.error('Error deleting property:', err);
    res.status(500).json({ error: err.message });
  }
});

// User Profile
app.get('/api/users/:id', authenticateToken, async (req, res) => {
  const userId = parseInt(req.params.id);
  
  if (req.user.id !== userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard Endpoints
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/properties', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const result = await pool.query(`
      SELECT p.*, u.name AS agent_name, u.email AS agent_email
      FROM properties p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching properties:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const userId = req.params.id;
  
  // Prevent admin from deleting themselves
  if (req.user.id == userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ 
      message: 'User deleted successfully', 
      user: result.rows[0] 
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Favorites Endpoints
app.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.* 
       FROM properties p
       JOIN favorites f ON p.id = f.property_id
       WHERE f.user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching favorites:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favorites/:propertyId', authenticateToken, async (req, res) => {
  const propertyId = req.params.propertyId;
  
  try {
    // Check if property exists
    const propertyCheck = await pool.query(
      'SELECT id FROM properties WHERE id = $1',
      [propertyId]
    );
    
    if (propertyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // Add to favorites
    const result = await pool.query(
      `INSERT INTO favorites (user_id, property_id)
       VALUES ($1, $2)
       RETURNING *`,
      [req.user.id, propertyId]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding favorite:', err);
    
    // Handle unique constraint violation
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Property is already in favorites' });
    }
    
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/favorites/:propertyId', authenticateToken, async (req, res) => {
  const propertyId = req.params.propertyId;
  
  try {
    const result = await pool.query(
      `DELETE FROM favorites 
       WHERE user_id = $1 AND property_id = $2
       RETURNING *`,
      [req.user.id, propertyId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Favorite not found' });
    }
    
    res.json({ 
      message: 'Favorite removed successfully', 
      favorite: result.rows[0] 
    });
  } catch (err) {
    console.error('Error removing favorite:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reviews Endpoints
app.get('/api/properties/:id/reviews', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS user_name
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       WHERE r.property_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching reviews:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/properties/:id/reviews', authenticateToken, async (req, res) => {
  const propertyId = req.params.id;
  const { review, rating } = req.body;
  
  try {
    // Validation
    if (!review || !rating) {
      return res.status(400).json({ error: 'Review and rating are required' });
    }
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    // Add review
    const result = await pool.query(
      `INSERT INTO reviews (property_id, user_id, review, rating)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [propertyId, req.user.id, review, rating]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding review:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});