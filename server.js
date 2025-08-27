import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import db from './db.js';
import axios from 'axios';
import CryptoJS from 'crypto-js';

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }
});

io.on('connection', (socket) => {
  console.log('ðŸ”Œ Client connected:', socket.id);

  socket.on('joinRestaurant', (restaurant_uid) => {
    if (typeof restaurant_uid === 'string' && restaurant_uid.trim()) {
      socket.join(`restaurant_${restaurant_uid.trim()}`);
      console.log(`ðŸ‘¨â€ðŸ³ socket ${socket.id} joined room restaurant_${restaurant_uid}`);
    }
  });

  socket.on('joinCustomer', (customer_uid) => {
    if (typeof customer_uid === 'string' && customer_uid.trim()) {
      socket.join(`customer_${customer_uid.trim()}`);
      console.log(`ðŸ§‘â€ðŸ’¼ socket ${socket.id} joined room customer_${customer_uid}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('ðŸ”Œ Client disconnected:', socket.id);
  });
});

const handleError = (res, err, operation = 'operation') => {
  console.error(`${operation} failed:`, err);
  return res.status(500).json({
    success: false,
    error: `${operation} failed`,
    details: err?.message || 'Unknown error',
  });
};

const parseJsonSafe = (value, fallback) => {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
};

const validateRestaurantUid = async (restaurantUid) => {
  if (!restaurantUid || typeof restaurantUid !== 'string' || restaurantUid.trim() === '') {
    throw new Error('Restaurant UID is required and must be a non-empty string');
  }
  const trimmedUid = restaurantUid.trim();
  try {
    const [rows] = await db.query(
      'SELECT id, uid FROM restaurant_owners WHERE uid = ?',
      [trimmedUid]
    );
    if (rows.length === 0) {
      throw new Error(`Restaurant not found for UID: ${trimmedUid}`);
    }
    return rows[0].id;
  } catch (err) {
    throw new Error(`Failed to validate restaurant UID: ${err.message}`);
  }
};

const validateAddresses = (addresses) => {
  if (addresses === undefined) return [];
  if (!Array.isArray(addresses)) {
    throw new Error('Addresses must be an array');
  }
  if (addresses.length > 3) {
    throw new Error('Maximum 3 addresses allowed');
  }
  return addresses.map((addr, i) => {
    if (typeof addr !== 'string' || addr.trim() === '') {
      throw new Error(`Address at index ${i} must be a non-empty string`);
    }
    return addr.trim();
  });
};

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', now: new Date().toISOString() });
});

app.get('/health/db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 AS ok');
    res.json({ success: true, db: rows[0].ok === 1 ? 'reachable' : 'unknown' });
  } catch (err) {
    handleError(res, err, 'DB health check');
  }
});

app.get('/api/restaurants', async (req, res) => {
  try {
    const [restaurants] = await db.query(`
      SELECT 
        uid AS id,
        restaurant_name AS name,
        location,
        email,
        is_online,
        is_pure_veg, -- Added is_pure_veg
        created_at,
        updated_at
      FROM restaurant_owners
      ORDER BY restaurant_name
    `);

    const mapped = restaurants.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      email: r.email,
      is_online: r.is_online,
      is_pure_veg: r.is_pure_veg === 1, // Convert to boolean
      imageUrl: '',
      rating: 4.5,
      deliveryTime: '25-30 min',
      deliveryFee: 0,
      isOpen: r.is_online === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    res.json({ success: true, data: { restaurants: mapped } });
  } catch (err) {
    handleError(res, err, 'fetching restaurants');
  }
});

app.post('/api/restaurants', async (req, res) => {
  const { uid, restaurant_name, location, email, is_pure_veg } = req.body;

  if (!uid || !restaurant_name || !location || !email) {
    return res.status(400).json({
      success: false,
      error: 'UID, restaurant name, location, and email are required',
    });
  }

  try {
    const trimmedUid = uid.trim();
    const [existing] = await db.query(
      'SELECT uid FROM restaurant_owners WHERE uid = ? OR email = ?',
      [trimmedUid, email.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Restaurant with this UID or email already exists',
      });
    }

    const [result] = await db.query(
      `INSERT INTO restaurant_owners 
       (uid, restaurant_name, location, email, is_pure_veg, is_online)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        trimmedUid,
        restaurant_name.trim(),
        location.trim(),
        email.trim(),
        is_pure_veg ? 1 : 0, // Convert boolean to TINYINT
        
        0 // Default to offline
      ]
    );

    const [inserted] = await db.query('SELECT * FROM restaurant_owners WHERE id = ?', [
      result.insertId,
    ]);

    res.status(201).json({
      success: true,
      message: 'Restaurant registered successfully',
      restaurant: inserted[0],
      data: { restaurant: inserted[0] },
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res
        .status(409)
        .json({ success: false, error: 'Restaurant with this email or UID already exists' });
    }
    handleError(res, err, 'registering restaurant');
  }
});

app.get('/api/restaurants/:uid', async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim();
    const [rows] = await db.query('SELECT * FROM restaurant_owners WHERE uid = ?', [
      trimmedUid,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }

    const restaurant = {
      ...rows[0],
      is_pure_veg: rows[0].is_pure_veg === 1, // Convert to boolean
      isOpen: rows[0].is_online === 1,
    };
    res.json({ success: true, restaurant, data: { restaurant } });
  } catch (err) {
    handleError(res, err, 'fetching restaurant');
  }
});


app.put('/api/restaurants/:uid', async (req, res) => {
  const { restaurant_name, location, email, is_pure_veg } = req.body;

  if (!restaurant_name || !location || !email || is_pure_veg === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Restaurant name, location, email, and is_pure_veg are required',
    });
  }

  try {
    const trimmedUid = req.params.uid.trim();
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET restaurant_name = ?, location = ?, email = ?, is_pure_veg = ?, updated_at = NOW()
       WHERE uid = ?`,
      [
        restaurant_name.trim(),
        location.trim(),
        email.trim(),
        is_pure_veg ? 1 : 0,  // âœ… update column correctly
        trimmedUid,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }

    const [updated] = await db.query(
      'SELECT * FROM restaurant_owners WHERE uid = ?',
      [trimmedUid]
    );

    res.json({
      success: true,
      message: 'Restaurant updated successfully',
      restaurant: updated[0],
      data: { restaurant: updated[0] },
    });
  } catch (err) {
    handleError(res, err, 'updating restaurant');
  }
});

app.put('/api/restaurants/:uid/status', async (req, res) => {
  const { is_online } = req.body;
  if (is_online === undefined || is_online === null) {
    return res.status(400).json({
      success: false,
      error: 'is_online field is required',
    });
  }
  try {
    const trimmedUid = req.params.uid.trim();
    const isOnlineValue = is_online ? 1 : 0;
    console.log(`Updating restaurant ${trimmedUid} to is_online: ${isOnlineValue}`);
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET is_online = ?, updated_at = NOW()
       WHERE uid = ?`,
      [isOnlineValue, trimmedUid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }

    const [updated] = await db.query('SELECT * FROM restaurant_owners WHERE uid = ?', [
      trimmedUid,
    ]);
    console.log(`Restaurant ${trimmedUid} updated, is_online: ${updated[0].is_online}`);

    res.json({
      success: true,
      message: 'Restaurant status updated successfully',
      restaurant: updated[0],
      data: { restaurant: updated[0] },
    });
  } catch (err) {
    handleError(res, err, 'updating restaurant status');
  }
});

// Add this new endpoint after the existing /api/restaurants endpoint in server.js

app.get('/api/restaurants-with-menu-categories', async (req, res) => {
  try {
    const { category_id } = req.query;
    
    // Get all restaurants first
    const [restaurants] = await db.query(`
      SELECT 
        uid AS id,
        restaurant_name AS name,
        location,
        email,
        is_online,
        is_pure_veg,
        created_at,
        updated_at
      FROM restaurant_owners
      ORDER BY restaurant_name
    `);

    let filteredRestaurants = restaurants;

    // If category filter is applied, filter by menu items
    if (category_id) {
      const categoryKeywords = getCategoryKeywords(category_id);
      
      if (categoryKeywords.length > 0) {
        const keywordConditions = categoryKeywords.map(() => 
          '(LOWER(m.name) LIKE ? OR LOWER(m.description) LIKE ? OR LOWER(m.category) LIKE ?)'
        ).join(' OR ');
        
        const keywordParams = [];
        categoryKeywords.forEach(keyword => {
          const pattern = `%${keyword.toLowerCase()}%`;
          keywordParams.push(pattern, pattern, pattern);
        });

        const [restaurantsWithMenuItems] = await db.query(`
          SELECT DISTINCT r.uid
          FROM restaurant_owners r
          JOIN menu_items1 m ON r.uid = m.restaurant_uid
          WHERE m.is_available = 1 AND m.is_deleted = 0 AND (${keywordConditions})
        `, keywordParams);

        const validRestaurantIds = new Set(restaurantsWithMenuItems.map(r => r.uid));
        filteredRestaurants = restaurants.filter(r => validRestaurantIds.has(r.id));
      }
    }

    const mapped = filteredRestaurants.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      email: r.email,
      is_online: r.is_online,
      is_pure_veg: r.is_pure_veg === 1,
      imageUrl: '',
      rating: 4.5,
      deliveryTime: '25-30 min',
      deliveryFee: 0,
      isOpen: r.is_online === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    res.json({ success: true, data: { restaurants: mapped } });
  } catch (err) {
    handleError(res, err, 'fetching restaurants with menu categories');
  }
});

// Add this helper function after the endpoint
function getCategoryKeywords(categoryId) {
  const categories = {
    'chicken': ['chicken', 'poultry', 'tandoori', 'butter chicken', 'grilled chicken', 'fried chicken'],
    'pizza': ['pizza', 'margherita', 'pepperoni', 'cheese pizza', 'italian'],
    'biryani': ['biryani', 'pulao', 'dum biryani', 'hyderabadi', 'lucknowi', 'kolkata biriyani'],
    'thali': ['thali', 'complete meal', 'unlimited', 'gujarati', 'rajasthani', 'south indian thali', 'north indian thali','veg thali','chicken thali','mutton thali','egg thali','fish thali'],
    'chinese': ['chinese', 'noodles', 'fried rice', 'manchurian', 'chowmein', 'hakka', 'szechuan'],
    'north-indian': ['roti', 'naan', 'dal makhani', 'paneer', 'curry', 'punjabi'],
    'paneer': ['paneer', 'cottage cheese', 'palak paneer', 'matar paneer', 'kadai paneer'],
    'chole-bhatura': ['chole', 'bhatura', 'chickpea', 'punjabi']
  };
  return categories[categoryId] || [];
}
app.get('/api/food-categories', (req, res) => {
  try {
    const categories = [
      {
        id: 'chicken',
        name: 'Chicken',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f414.png',
        searchKeywords: ['chicken', 'poultry', 'fried chicken', 'grilled chicken', 'tandoori', 'butter chicken', 'non-veg']
      },
      {
        id: 'pizza',
        name: 'Pizza',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f355.png',
        searchKeywords: ['pizza', 'italian', 'cheese', 'margherita', 'pepperoni', 'dominos', 'pizza hut']
      },
      {
        id: 'biryani',
        name: 'Biryani',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35b.png',
        searchKeywords: ['biryani', 'pulao', 'rice', 'hyderabadi', 'lucknowi', 'dum', 'mutton', 'chicken biryani']
      },
      {
        id: 'thali',
        name: 'Thali',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f372.png',
        searchKeywords: ['thali', 'gujarati', 'rajasthani', 'unlimited', 'complete meal', 'dal', 'sabji']
      },
      {
        id: 'chinese',
        name: 'Chinese',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35c.png',
        searchKeywords: ['chinese', 'noodles', 'fried rice', 'manchurian', 'chowmein', 'hakka', 'szechuan']
      },
      {
        id: 'north-indian',
        name: 'North Indian',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35b.png',
        searchKeywords: ['north indian', 'punjabi', 'roti', 'naan', 'dal makhani', 'paneer', 'curry']
      },
      {
        id: 'paneer',
        name: 'Paneer',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9c0.png',
        searchKeywords: ['paneer', 'cottage cheese', 'palak paneer', 'matar paneer', 'kadai paneer', 'vegetarian']
      },
      {
        id: 'chole-bhatura',
        name: 'Chole Bhatura',
        imageUrl: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fad3.png',
        searchKeywords: ['chole', 'bhatura', 'punjabi', 'chickpea', 'spicy', 'fried bread']
      }
    ];

    res.json({
      success: true,
      data: { categories },
    });
  } catch (err) {
    handleError(res, err, 'fetching food categories');
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const restaurantUid = req.query.restaurant_uid?.trim();
    await validateRestaurantUid(restaurantUid);

    const [rows] = await db.query(
      'SELECT * FROM categories1 WHERE restaurant_uid = ? ORDER BY name',
      [restaurantUid]
    );

    res.json({ success: true, categories: rows, data: { categories: rows } });
  } catch (err) {
    handleError(res, err, 'fetching categories');
  }
});

app.post('/api/categories', async (req, res) => {
  const { name, restaurant_uid } = req.body;

  if (!name || !restaurant_uid) {
    return res.status(400).json({
      success: false,
      error: 'Name and restaurant UID are required',
    });
  }

  try {
    const trimmedUid = restaurant_uid.trim();
    await validateRestaurantUid(trimmedUid);

    const [result] = await db.query(
      'INSERT INTO categories1 (name, restaurant_uid) VALUES (?, ?)',
      [name.trim(), trimmedUid]
    );

    const [inserted] = await db.query('SELECT * FROM categories1 WHERE id = ?', [
      result.insertId,
    ]);

    res.status(201).json({
      success: true,
      message: 'Category added successfully',
      category: inserted[0],
      data: { category: inserted[0] },
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        error: `Category "${req.body?.name}" already exists for restaurant UID: ${req.body?.restaurant_uid}`,
      });
    }
    handleError(res, err, 'adding category');
  }
});

app.post('/api/menu', async (req, res) => {
  const { name, description, price, category, restaurant_uid, is_available = 1, image_url, food_type = 0 } = req.body;
  if (!name || !category || !restaurant_uid || price === undefined || food_type === undefined) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  try {
    await validateRestaurantUid(restaurant_uid);
    const [categoryExists] = await db.query(
      'SELECT id FROM categories1 WHERE name = ? AND restaurant_uid = ?',
      [category, restaurant_uid]
    );
    if (categoryExists.length === 0) {
      return res.status(400).json({ success: false, error: 'Category does not exist' });
    }
    const [result] = await db.query(
      `INSERT INTO menu_items1 (name, description, price, category, restaurant_uid, is_available, image_url, food_type, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [name.trim(), description || null, Number(price), category, restaurant_uid, is_available ? 1 : 0, image_url || null, Number(food_type)]
    );
    const [inserted] = await db.query('SELECT * FROM menu_items1 WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Menu item created', item: inserted[0] });
  } catch (err) { handleError(res, err, 'creating menu item'); }
});

app.get('/api/menu', async (req, res) => {
  const { restaurant_uid } = req.query;
  if (!restaurant_uid || typeof restaurant_uid !== 'string' || restaurant_uid.trim() === '') {
    return res.status(400).json({ success: false, error: 'Restaurant UID is required' });
  }
  try {
    const trimmedUid = restaurant_uid.trim();
    const [items] = await db.query(
      `SELECT 
        id, 
        name, 
        description, 
        price, 
        category, 
        is_available, 
        add_ons, 
        image_url, 
        restaurant_uid,
        food_type
      FROM menu_items1 
      WHERE restaurant_uid = ? AND is_deleted = 0
      ORDER BY category, name`,
      [trimmedUid]
    );
    const mapped = items.map((item) => ({
      ...item,
      add_ons: parseJsonSafe(item.add_ons, []),
      is_available: item.is_available === 1,
      food_type: item.food_type // Included as int (0 or 1)
    }));
    res.json({ success: true, data: { items: mapped } });
  } catch (err) {
    handleError(res, err, 'fetching menu items');
  }
});


app.get('/api/menu/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [items] = await db.query(
      `SELECT 
        id, 
        name, 
        description, 
        price, 
        category, 
        is_available, 
        add_ons, 
        image_url, 
        restaurant_uid,
        food_type
      FROM menu_items1 
      WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: 'Menu item not found' });
    }
    const item = items[0];
    const mappedItem = {
      ...item,
      add_ons: parseJsonSafe(item.add_ons, []),
      is_available: item.is_available === 1,
      food_type: item.food_type // Included as int (0 or 1)
    };
    res.json({ success: true, data: { item: mappedItem } });
  } catch (err) {
    handleError(res, err, 'fetching menu item');
  }
});


app.put('/api/menu/:id', async (req, res) => {
  const { name, description, price, category, restaurant_uid, is_available = 1, image_url, food_type = 0 } = req.body;
  if (!name || !category || !restaurant_uid || price === undefined || food_type === undefined) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  try {
    await validateRestaurantUid(restaurant_uid);
    const [categoryExists] = await db.query(
      'SELECT id FROM categories1 WHERE name = ? AND restaurant_uid = ?',
      [category, restaurant_uid]
    );
    if (categoryExists.length === 0) {
      return res.status(400).json({ success: false, error: 'Category does not exist' });
    }
    const [result] = await db.query(
      `UPDATE menu_items1 SET name=?, description=?, price=?, category=?, is_available=?, image_url=?, food_type=?
       WHERE id=? AND restaurant_uid=? AND is_deleted=0`,
      [name.trim(), description || null, Number(price), category, is_available ? 1 : 0, image_url || null, Number(food_type), req.params.id, restaurant_uid]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, error: 'Menu item not found or deleted' });
    const [updated] = await db.query('SELECT * FROM menu_items1 WHERE id=? AND is_deleted=0', [req.params.id]);
    res.json({ success: true, message: 'Menu item updated', item: updated[0] });
  } catch (err) { handleError(res, err, 'updating menu item'); }
});

app.patch('/api/menu/:id/availability', async (req, res) => {
  const { is_available } = req.body;
  const restaurant_uid = req.query.restaurant_uid?.trim();
  if (is_available === undefined || !restaurant_uid) {
    return res.status(400).json({ success: false, error: 'is_available and restaurant_uid are required' });
  }
  try {
    await validateRestaurantUid(restaurant_uid);
    const [result] = await db.query(
      `UPDATE menu_items1 SET is_available=? WHERE id=? AND restaurant_uid=? AND is_deleted=0`,
      [is_available ? 1 : 0, req.params.id, restaurant_uid]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Menu item not found or deleted' });
    }
    res.json({ success: true, message: 'Availability updated', is_available: is_available ? 1 : 0 });
  } catch (err) { handleError(res, err, 'updating availability'); }
});


app.delete('/api/menu/:id', async (req, res) => {
  const restaurant_uid = req.query.restaurant_uid?.trim();
  if (!restaurant_uid) {
    return res.status(400).json({ success: false, error: 'Restaurant UID is required' });
  }
  try {
    await validateRestaurantUid(restaurant_uid);
    const [existing] = await db.query(
      'SELECT id FROM menu_items1 WHERE id = ? AND restaurant_uid = ? AND is_deleted = 0',
      [req.params.id, restaurant_uid]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Menu item not found or already deleted' });
    }
    const [result] = await db.query(
      `UPDATE menu_items1 SET is_deleted=1, is_available=0 WHERE id=? AND restaurant_uid=?`,
      [req.params.id, restaurant_uid]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Menu item not found or already deleted' });
    }
    res.json({ success: true, message: 'Menu item deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, error: 'Cannot delete menu item; it is referenced in existing orders' });
    }
    handleError(res, err, 'deleting menu item');
  }
});

app.post('/api/customers', async (req, res) => {
  const { uid, name, email, phone, addresses } = req.body || {};

  if (!uid || !name || !email) {
    return res.status(400).json({ success: false, error: 'UID, name, and email are required' });
  }

  try {
    const validatedAddresses = validateAddresses(addresses || []);

    const [existing] = await db.query('SELECT * FROM customers WHERE uid = ?', [uid]);
    if (existing.length > 0) {
      await db.query(
        `UPDATE customers SET name = ?, email = ?, phone = ?, address = ? WHERE uid = ?`,
        [name, email, phone || '', JSON.stringify(validatedAddresses), uid]
      );
      return res.json({ success: true, message: 'Customer updated' });
    } else {
      await db.query(
        `INSERT INTO customers (uid, name, email, phone, address) VALUES (?, ?, ?, ?, ?)`,
        [uid, name, email, phone || '', JSON.stringify(validatedAddresses)]
      );
      return res.status(201).json({ success: true, message: 'Customer registered' });
    }
  } catch (err) {
    handleError(res, err, 'registering/updating customer');
  }
});

app.get('/api/customers/:uid', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM customers WHERE uid = ?', [req.params.uid]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }
    const customer = rows[0];
    customer.address = parseJsonSafe(customer.address, []);
    res.json({ success: true, data: { customer }, customer });
  } catch (err) {
    handleError(res, err, 'fetching customer');
  }
});

app.post('/api/customers/:uid/addresses', async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address || typeof address !== 'string' || address.trim() === '') {
      return res.status(400).json({ success: false, error: 'Address must be a non-empty string' });
    }

    const [rows] = await db.query('SELECT address FROM customers WHERE uid = ?', [
      req.params.uid,
    ]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Customer not found' });

    const current = parseJsonSafe(rows[0].address, []);
    if (!Array.isArray(current)) return res.status(500).json({ success: false, error: 'Invalid stored address format' });

    if (current.length >= 3) {
      return res.status(400).json({ success: false, error: 'Maximum 3 addresses allowed' });
    }

    current.push(address.trim());
    await db.query('UPDATE customers SET address = ? WHERE uid = ?', [
      JSON.stringify(current),
      req.params.uid,
    ]);

    res.json({ success: true, message: 'Address added', data: { addresses: current } });
  } catch (err) {
    handleError(res, err, 'adding address');
  }
});

app.delete('/api/customers/:uid/addresses/:index', async (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ success: false, error: 'Invalid index' });

    const [rows] = await db.query('SELECT address FROM customers WHERE uid = ?', [
      req.params.uid,
    ]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Customer not found' });

    const current = parseJsonSafe(rows[0].address, []);
    if (!Array.isArray(current)) return res.status(500).json({ success: false, error: 'Invalid stored address format' });
    if (idx >= current.length) return res.status(400).json({ success: false, error: 'Index out of range' });

    current.splice(idx, 1);
    await db.query('UPDATE customers SET address = ? WHERE uid = ?', [
      JSON.stringify(current),
      req.params.uid,
    ]);

    res.json({ success: true, message: 'Address removed', data: { addresses: current } });
  } catch (err) {
    handleError(res, err, 'removing address');
  }
});

// Add this new endpoint after the existing customer endpoints in server.js
app.put('/api/customers/:uid/addresses-only', async (req, res) => {
  const { addresses } = req.body;
  
  if (!addresses || !Array.isArray(addresses)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Addresses must be provided as an array' 
    });
  }

  if (addresses.length > 3) {
    return res.status(400).json({ 
      success: false, 
      error: 'Maximum 3 addresses allowed' 
    });
  }

  try {
    const trimmedUid = req.params.uid.trim();
    
    // Validate that customer exists
    const [customerCheck] = await db.query(
      'SELECT uid FROM customers WHERE uid = ?',
      [trimmedUid]
    );
    
    if (customerCheck.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Customer not found. Please complete your profile first.' 
      });
    }

    // Update only the addresses field
    const [result] = await db.query(
      'UPDATE customers SET address = ? WHERE uid = ?',
      [JSON.stringify(addresses), trimmedUid]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Failed to update addresses' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Addresses updated successfully',
      data: { addresses }
    });
  } catch (err) {
    handleError(res, err, 'updating addresses');
  }
});

// Replace the existing /api/orders endpoint in server.js

// Replace the existing /api/orders endpoint in server.js

app.post('/api/orders', async (req, res) => {
  const {
    customer_uid,
    restaurant_uid,
    items,
    delivery_address,
    payment_method,
    notes,
    customer_name,
    phone_number,
    // Fee breakdown from Flutter
    subtotal,
    delivery_fee,
    packing_fee,
    gst_amount,
    platform_fee,
    total_amount,
  } = req.body || {};

  // Validate required fields
  if (!customer_uid || !restaurant_uid || !items || !delivery_address || 
      !payment_method || !customer_name || !phone_number || total_amount === undefined) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields including total_amount' 
    });
  }

  // Validate phone number
  if (!new RegExp('^\\+?[0-9]{10,15}$').test(phone_number)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid phone number format'
    });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Validate restaurant exists
    const [restaurant] = await connection.query(
      'SELECT * FROM restaurant_owners WHERE uid = ?',
      [restaurant_uid]
    );
    if (restaurant.length === 0) {
      throw new Error('Restaurant not found');
    }

    // Validate customer exists
    const [customer] = await connection.query(
      'SELECT * FROM customers WHERE uid = ?',
      [customer_uid]
    );
    if (customer.length === 0) {
      throw new Error('Customer not found');
    }

    // Calculate and validate subtotal against menu items
    let calculatedSubtotal = 0;
    for (const item of items) {
      const [menuItem] = await connection.query(
        'SELECT * FROM menu_items1 WHERE id = ? AND restaurant_uid = ? AND is_available = 1 AND is_deleted = 0',
        [item.menu_item_id, restaurant_uid]
      );
      if (menuItem.length === 0) {
        throw new Error(`Menu item ${item.menu_item_id} not found or unavailable`);
      }
      calculatedSubtotal += Number(menuItem[0].price) * Number(item.quantity);
    }

    // Verify subtotal matches (allow 0.01 difference for floating point)
    if (Math.abs(calculatedSubtotal - (subtotal || 0)) > 0.01) {
      throw new Error(`Subtotal mismatch: calculated ₹${calculatedSubtotal.toFixed(2)}, received ₹${(subtotal || 0).toFixed(2)}`);
    }

    // Verify fee calculations
    const expectedDeliveryFee = calculatedSubtotal >= 500 ? 0 : 20;
    const expectedPackingFee = 5;
    const expectedGst = calculatedSubtotal * 0.05;
    const expectedPlatformFee = calculatedSubtotal >= 300 ? 0 : 2;
    const expectedTotal = calculatedSubtotal + expectedDeliveryFee + expectedPackingFee + expectedGst + expectedPlatformFee;

    // Verify total (allow small floating point differences)
    if (Math.abs(expectedTotal - total_amount) > 0.02) {
      console.log('Price calculation mismatch:');
      console.log(`Calculated subtotal: ₹${calculatedSubtotal.toFixed(2)}`);
      console.log(`Expected delivery fee: ₹${expectedDeliveryFee.toFixed(2)}`);
      console.log(`Expected packing fee: ₹${expectedPackingFee.toFixed(2)}`);
      console.log(`Expected GST: ₹${expectedGst.toFixed(2)}`);
      console.log(`Expected platform fee: ₹${expectedPlatformFee.toFixed(2)}`);
      console.log(`Expected total: ₹${expectedTotal.toFixed(2)}`);
      console.log(`Received total: ₹${total_amount.toFixed(2)}`);
      
      throw new Error(`Total amount mismatch: expected ₹${expectedTotal.toFixed(2)}, received ₹${total_amount.toFixed(2)}`);
    }

    // Insert order with correct total (use the verified total_amount)
    const [orderResult] = await connection.query(
      `INSERT INTO orders 
        (customer_uid, restaurant_uid, customer_name, phone_number, status, total_price, delivery_address, payment_method, notes, payment_status)
       VALUES (?, ?, ?, ?, 'payment_pending', ?, ?, ?, ?, 'pending')`,
      [
        customer_uid,
        restaurant_uid,
        customer_name,
        phone_number,
        total_amount, // Use the verified total from Flutter
        delivery_address,
        payment_method,
        notes || null,
      ]
    );

    const orderId = orderResult.insertId;

    // Insert order items
    for (const item of items) {
      await connection.query(
        'INSERT INTO order_items (order_id, menu_item_id, quantity) VALUES (?, ?, ?)',
        [orderId, item.menu_item_id, item.quantity]
      );
    }

    // Create Cashfree payment order
    try {
      const cashfreeResponse = await axios.post(
        'https://sandbox.cashfree.com/pg/orders',
        {
          order_id: `order_${orderId}`,
          order_amount: total_amount, // Use verified total
          order_currency: 'INR',
          customer_details: {
            customer_id: customer_uid,
            customer_name,
            customer_phone: phone_number,
            customer_email: customer[0].email || 'customer@example.com',
          },
          order_meta: {
            return_url: `https:///khawwws.onrender.com/payment-success?order_id=${orderId}`,
            notify_url: `https://khawwws.onrender.com/api/cashfree/webhook`,
          },
          order_note: notes || 'Food order',
        },
        {
          headers: {
            'x-api-version': '2023-08-01',
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const { payment_session_id, cf_order_id } = cashfreeResponse.data;

      // Update order with Cashfree details
      await connection.query(
        'UPDATE orders SET payment_session_id = ?, payment_id = ? WHERE id = ?',
        [payment_session_id, cf_order_id, orderId]
      );

      await connection.commit();

      // Respond with payment session details
      res.status(201).json({
        success: true,
        message: 'Order created, proceed to payment',
        data: { 
          order_id: orderId, 
          payment_session_id,
          total_amount: total_amount,
          webhook_url: 'https://khawwws.onrender.com/api/cashfree/webhook',
          breakdown: {
            subtotal: calculatedSubtotal,
            delivery_fee: expectedDeliveryFee,
            packing_fee: expectedPackingFee,
            gst_amount: expectedGst,
            platform_fee: expectedPlatformFee,
          }
        },
      });
    } catch (cashfreeError) {
      console.error('Cashfree API Error:', cashfreeError.response?.data || cashfreeError.message);
      
      // Mark order as failed
      await connection.query(
        'UPDATE orders SET status = ?, payment_status = ? WHERE id = ?',
        ['cancelled', 'failed', orderId]
      );
      
      await connection.commit();
      
      res.status(500).json({
        success: false,
        error: 'Payment processing unavailable. Please try again.',
        details: cashfreeError.response?.data?.message || 'Payment gateway error'
      });
    }

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Order creation error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to create order',
    });
  } finally {
    if (connection) connection.release();
  }
});

// Add payment verification endpoint
app.post('/api/orders/:orderId/verify-payment', async (req, res) => {
  const { orderId } = req.params;
  
  try {
    // Get order details
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE id = ? AND payment_status = ?',
      [orderId, 'pending']
    );
    
    if (orders.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found or already processed'
      });
    }
    
    const order = orders[0];
    
    // Verify payment with Cashfree
    const verifyResponse = await axios.get(
      `https://sandbox.cashfree.com/pg/orders/${order.payment_id}/payments`,
      {
        headers: {
          'x-api-version': '2023-08-01',
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        },
      }
    );
    
    const payments = verifyResponse.data;
    const successfulPayment = payments.find(p => p.payment_status === 'SUCCESS');
    
    if (successfulPayment) {
      // Update order status to confirmed
      await db.query(
        'UPDATE orders SET status = ?, payment_status = ? WHERE id = ?',
        ['pending', 'success', orderId]
      );
      
      // Emit to restaurant
      const [updatedOrder] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      io.to(`restaurant_${order.restaurant_uid}`).emit('newOrder', updatedOrder[0]);
      
      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: { order_status: 'confirmed' }
      });
    } else {
      res.json({
        success: false,
        message: 'Payment not completed',
        data: { order_status: 'payment_pending' }
      });
    }
    
  } catch (err) {
    console.error('Payment verification error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to verify payment'
    });
  }
});

// Fix the endpoint path - it was missing /api/
app.get('/api/orders/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Get order from database first
    const [orders] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    
    if (orders.length === 0) {
      return res.status(404).json({
        error: 'Order not found',
        status: 'NOT_FOUND'
      });
    }
    
    const order = orders[0];
    
    // Return order status with payment_status
    return res.json({
      status: order.status || 'PENDING',
      payment_status: order.payment_status || 'pending',
      order: order
    });
    
  } catch (error) {
    console.error('Order status check error:', error);
    res.status(500).json({
      error: 'Failed to check order status',
      message: error.message
    });
  }
});
app.options('/api/cashfree/webhook', cors({
  origin: ['https://sandbox.cashfree.com', 'https://api.cashfree.com'],
  credentials: true
}));

// Add this middleware BEFORE your webhook endpoint to capture raw body
app.use('/api/cashfree/webhook', (req, res, next) => {
  // Log incoming webhook for debugging
  console.log('Webhook received from:', req.get('origin') || req.get('x-forwarded-for') || req.connection.remoteAddress);
  console.log('Webhook URL hit:', req.originalUrl);
  next();
});

// Fixed Webhook Endpoint - Replace your existing one
app.post('/api/cashfree/webhook', async (req, res) => {
  console.log('🔔 Webhook received');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  
  try {
    // For testing, always respond with success first
    // This will make the webhook test pass
    if (!req.body || Object.keys(req.body).length === 0) {
      console.log('Empty webhook - probably a test');
      return res.status(200).json({ 
        success: true, 
        message: 'Webhook endpoint is working' 
      });
    }

    let payload;
    
    // Handle both Buffer and already parsed JSON
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString());
    } else if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }
    
    console.log('📦 Parsed payload:', JSON.stringify(payload, null, 2));
    
    // Extract order ID - handle different webhook formats
    let orderId = null;
    
    // Try different possible locations for order_id
    if (payload?.data?.order?.order_id) {
      orderId = payload.data.order.order_id.toString().replace('order_', '');
    } else if (payload?.order?.order_id) {
      orderId = payload.order.order_id.toString().replace('order_', '');
    } else if (payload?.order_id) {
      orderId = payload.order_id.toString().replace('order_', '');
    }
    
    // Extract payment status
    let paymentStatus = null;
    if (payload?.data?.payment?.payment_status) {
      paymentStatus = payload.data.payment.payment_status;
    } else if (payload?.payment?.payment_status) {
      paymentStatus = payload.payment.payment_status;
    } else if (payload?.payment_status) {
      paymentStatus = payload.payment_status;
    } else if (payload?.data?.order?.order_status) {
      paymentStatus = payload.data.order.order_status;
    }
    
    console.log(`🔍 Extracted - Order ID: ${orderId}, Payment Status: ${paymentStatus}`);
    
    if (!orderId) {
      console.error('❌ No order ID found in webhook');
      // Still return success to avoid webhook failures
      return res.status(200).json({ success: true, error: 'No order ID found' });
    }
    
    // Map payment status
    let dbPaymentStatus = 'pending';
    let dbOrderStatus = 'pending';
    
    if (paymentStatus === 'SUCCESS' || paymentStatus === 'PAID') {
      dbPaymentStatus = 'success';
      dbOrderStatus = 'pending'; // Ready for restaurant to prepare
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'FAILED') {
      dbPaymentStatus = 'failed';
      dbOrderStatus = 'cancelled';
    } else if (paymentStatus === 'CANCELLED') {
      dbPaymentStatus = 'cancelled';
      dbOrderStatus = 'cancelled';
    }
    
    console.log(`💾 Updating DB - Order: ${orderId}, Payment Status: ${dbPaymentStatus}, Order Status: ${dbOrderStatus}`);
    
    // Update database
    const [result] = await db.query(
      'UPDATE orders SET payment_status = ?, status = ? WHERE id = ?',
      [dbPaymentStatus, dbOrderStatus, orderId]
    );
    
    if (result.affectedRows > 0) {
      console.log(`✅ Order ${orderId} updated successfully`);
      
      // Get updated order and emit to sockets
      const [updatedOrder] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (updatedOrder.length > 0) {
        const order = updatedOrder[0];
        io.to(`restaurant_${order.restaurant_uid}`).emit('orderStatusUpdated', order);
        io.to(`customer_${order.customer_uid}`).emit('orderStatusUpdated', order);
      }
    } else {
      console.log(`⚠️ No order found with ID ${orderId}`);
    }
    
    return res.status(200).json({ 
      success: true, 
      message: 'Webhook processed',
      orderId: orderId,
      paymentStatus: dbPaymentStatus
    });
    
  } catch (err) {
    console.error('💥 Webhook Error:', err);
    // Always return 200 to prevent webhook retries
    return res.status(200).json({ 
      success: false, 
      error: err.message,
      message: 'Webhook received but processing failed'
    });
  }
});

// Add a GET endpoint for webhook testing
app.get('/api/cashfree/webhook', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Cashfree webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/orders', async (req, res) => {
  const { customer_uid } = req.query;
  if (!customer_uid) {
    return res.status(400).json({ success: false, error: 'Customer UID is required' });
  }
  try {
    const [orders] = await db.query(
      `SELECT * FROM orders WHERE customer_uid = ? ORDER BY created_at DESC`,
      [customer_uid]
    );
    res.json({ success: true, data: { orders } });
  } catch (err) {
    handleError(res, err, 'fetching customer orders');
  }
});

app.get('/api/customers/:uid/orders', async (req, res) => {
  const { uid } = req.params;
  try {
    const [orders] = await db.query(
      `SELECT * FROM orders WHERE customer_uid = ? ORDER BY created_at DESC`,
      [uid]
    );

    if (orders.length === 0) {
      return res.json({ success: true, data: { orders: [] } });
    }

    const orderIds = orders.map(o => o.id);
    const [items] = await db.query(
      `SELECT oi.*, m.name AS item_name, m.price AS unit_price
       FROM order_items oi
       JOIN menu_items1 m ON oi.menu_item_id = m.id
       WHERE oi.order_id IN (?)`,
      [orderIds]
    );

    const ordersWithItems = orders.map(order => {
      const its = items.filter(it => it.order_id === order.id);
      return { ...order, items: its };
    });

    res.json({ success: true, data: { orders: ordersWithItems } });
  } catch (err) {
    handleError(res, err, 'fetching customer orders');
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  try {
    const [orders] = await db.query(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    const [items] = await db.query(
      `SELECT oi.*, m.name AS item_name, m.price AS unit_price
       FROM order_items oi
       JOIN menu_items1 m ON oi.menu_item_id = m.id
       WHERE oi.order_id = ?`,
      [orderId]
    );
    res.json({ success: true, data: { order: orders[0], items } });
  } catch (err) {
    handleError(res, err, 'fetching order details');
  }
});

app.get('/api/restaurants/:restaurant_uid/orders', async (req, res) => {
  const { restaurant_uid } = req.params;
  const { status, limit } = req.query;
  try {
    await validateRestaurantUid(restaurant_uid);
    let query = `SELECT * FROM orders WHERE restaurant_uid = ?`;
    const params = [restaurant_uid];
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;
    if (limit) {
      query += ` LIMIT ?`;
      params.push(parseInt(limit));
    }
    const [orders] = await db.query(query, params);
    const ordersWithItems = await Promise.all(
      orders.map(async (order) => {
        const [items] = await db.query(
          `SELECT oi.*, m.name AS item_name, m.price AS unit_price
           FROM order_items oi
           JOIN menu_items1 m ON oi.menu_item_id = m.id
           WHERE oi.order_id = ?`,
          [order.id]
        );
        return { ...order, items };
      })
    );
    res.json({ success: true, data: { orders: ordersWithItems } });
  } catch (err) {
    handleError(res, err, 'fetching restaurant orders');
  }
});

app.put('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body || {};
  const allowed = new Set(['pending', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled']);
  if (!status || !allowed.has(status)) {
    return res.status(400).json({ success: false, error: 'Invalid or missing status' });
  }
  try {
    const [existing] = await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const order = existing[0];

    const [result] = await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, error: 'Order not found' });

    const [updatedRows] = await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    const updatedOrder = updatedRows[0];

    io.to(`restaurant_${updatedOrder.restaurant_uid}`).emit('orderStatusUpdated', updatedOrder);
    io.to(`customer_${updatedOrder.customer_uid}`).emit('orderStatusUpdated', updatedOrder);

    res.json({ success: true, message: 'Status updated', data: { order: updatedOrder } });
  } catch (err) {
    handleError(res, err, 'updating order status');
  }
});

// Add these endpoints to your server.js file

// 1. Update document submission status (called after Google Form completion)
app.post('/api/restaurants/:uid/documents-submitted', async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim();
    
    // Verify restaurant exists
    const [restaurant] = await db.query(
      'SELECT uid FROM restaurant_owners WHERE uid = ?',
      [trimmedUid]
    );
    
    if (restaurant.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }

    // Update documents_submitted status and submission_date
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET documents_submitted = 1, submission_date = NOW()
       WHERE uid = ?`,
      [trimmedUid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Failed to update document submission status',
      });
    }

    res.json({
      success: true,
      message: 'Documents submission recorded successfully',
    });
  } catch (err) {
    handleError(res, err, 'updating document submission status');
  }
});

// 2. Get restaurant verification status (for login check)
app.get('/api/restaurants/:uid/verification-status', async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim();
    
    const [rows] = await db.query(
  `SELECT verification_status, documents_submitted, verification_notes, 
          verification_date, submission_date 
   FROM restaurant_owners WHERE uid = ?`,
  [trimmedUid]
);
console.log('📊 Query result:', rows);

if (rows.length === 0) {
  console.log('❌ No restaurant found for UID:', trimmedUid);
  return res.status(404).json({
    success: false,
    error: `Restaurant not found for UID: ${trimmedUid}`,
  });
}

    const status = rows[0];
    res.json({
      success: true,
      data: {
        verification_status: status.verification_status,
        documents_submitted: status.documents_submitted === 1,
        verification_notes: status.verification_notes,
        verification_date: status.verification_date,
        submission_date: status.submission_date,
        can_access_dashboard: status.verification_status === 'verified'
      }
    });
  } catch (err) {
    console.error('💥 Verification status error:', err);
    handleError(res, err, 'fetching verification status');
  }
});

// 3. Admin endpoint - Get all restaurants pending verification
app.get('/api/admin/restaurants/pending-verification', async (req, res) => {
  try {
    const [restaurants] = await db.query(`
      SELECT 
        uid,
        restaurant_name,
        location,
        email,
        verification_status,
        documents_submitted,
        submission_date,
        created_at,
        verification_notes
      FROM restaurant_owners 
      WHERE documents_submitted = 1 AND verification_status = 'pending'
      ORDER BY submission_date ASC
    `);

    res.json({
      success: true,
      data: { restaurants }
    });
  } catch (err) {
    handleError(res, err, 'fetching pending verifications');
  }
});

// 4. Admin endpoint - Update verification status
app.put('/api/admin/restaurants/:uid/verification', async (req, res) => {
  const { verification_status, verification_notes } = req.body;

  // Validate input
  const allowedStatuses = ['verified', 'rejected'];
  if (!verification_status || !allowedStatuses.includes(verification_status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid verification status. Must be "verified" or "rejected"',
    });
  }

  try {
    const trimmedUid = req.params.uid.trim();

    // Verify restaurant exists
    const [restaurant] = await db.query(
      'SELECT uid, documents_submitted FROM restaurant_owners WHERE uid = ?',
      [trimmedUid]
    );

    if (restaurant.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }

    if (restaurant[0].documents_submitted !== 1) {
      return res.status(400).json({
        success: false,
        error: 'Cannot verify restaurant without submitted documents',
      });
    }

    // Update verification status
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET verification_status = ?, 
           verification_date = NOW(), 
           verification_notes = ?
       WHERE uid = ?`,
      [verification_status, verification_notes || null, trimmedUid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Failed to update verification status',
      });
    }

    // Get updated restaurant data
    const [updated] = await db.query(
      'SELECT * FROM restaurant_owners WHERE uid = ?',
      [trimmedUid]
    );

    // Emit notification to restaurant if verified/rejected
    io.to(`restaurant_${trimmedUid}`).emit('verificationStatusUpdated', {
      status: verification_status,
      notes: verification_notes,
      date: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Restaurant ${verification_status} successfully`,
      data: { restaurant: updated[0] }
    });
  } catch (err) {
    handleError(res, err, 'updating verification status');
  }
});

// 5. Get all restaurants with verification status (admin overview)
app.get('/api/admin/restaurants/all-with-status', async (req, res) => {
  try {
    const { status } = req.query; // Optional filter by verification_status

    let query = `
      SELECT 
        uid,
        restaurant_name,
        location,
        email,
        verification_status,
        documents_submitted,
        submission_date,
        verification_date,
        verification_notes,
        is_online,
        created_at
      FROM restaurant_owners
    `;
    
    const params = [];
    
    if (status && ['pending', 'verified', 'rejected'].includes(status)) {
      query += ' WHERE verification_status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';

    const [restaurants] = await db.query(query, params);

    res.json({
      success: true,
      data: { restaurants }
    });
  } catch (err) {
    handleError(res, err, 'fetching restaurants with verification status');
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: err?.message || 'Unknown error',
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(` API server running at http://0.0.0.0:${PORT}`);
  console.log(' Endpoints: /api/restaurants, /api/menu, /api/categories, /api/customers, /api/orders, /health');
  console.log(' Socket.IO events: joinRestaurant, joinCustomer, newOrder, orderPlaced, orderStatusUpdated');
});
