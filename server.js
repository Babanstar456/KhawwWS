import express from "express"
import cors from "cors"
import bodyParser from "body-parser"
import http from "http"
import { Server as SocketIOServer } from "socket.io"
import db from "./db.js"
import axios from "axios"
import admin from "firebase-admin"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

// Initialize Firebase Admin SDK using environment variables
const serviceAccount = {
  type: process.env.FIREBASE_TYPE || "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'), // Handle newlines in private key
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
  token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
}

// Validate required fields
const requiredFields = ['project_id', 'private_key', 'client_email']
const missingFields = requiredFields.filter(field => !serviceAccount[field])

if (missingFields.length > 0) {
  console.error("❌ Missing required Firebase environment variables:")
  missingFields.forEach(field => {
    console.error(`  - FIREBASE_${field.toUpperCase()}`)
  })
  console.error("\n📍 Please ensure all required Firebase environment variables are set in your .env file")
  process.exit(1)
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
  })

  console.log("✅ Firebase Admin SDK initialized successfully from environment variables")

} catch (error) {
  console.error("❌ Failed to initialize Firebase Admin SDK:", error.message)
  console.error("Make sure your Firebase credentials are correct in the .env file")
  process.exit(1)
}



const app = express()
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)
app.use(bodyParser.json())

const server = http.createServer(app)
const io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] },
})

io.on("connection", (socket) => {
  console.log("ðŸ”Œ Client connected:", socket.id)

  socket.on("joinRestaurant", (restaurant_uid) => {
    if (typeof restaurant_uid === "string" && restaurant_uid.trim()) {
      socket.join(`restaurant_${restaurant_uid.trim()}`)
      console.log(`ðŸ‘¨â€ðŸ³ socket ${socket.id} joined room restaurant_${restaurant_uid}`)
    }
  })

  socket.on("joinCustomer", (customer_uid) => {
    if (typeof customer_uid === "string" && customer_uid.trim()) {
      socket.join(`customer_${customer_uid.trim()}`)
      console.log(`ðŸ§‘â€ðŸ’¼ socket ${socket.id} joined room customer_${customer_uid}`)
    }
  })

  socket.on("disconnect", () => {
    console.log("ðŸ”Œ Client disconnected:", socket.id)
  })
})

const handleError = (res, err, operation = "operation") => {
  console.error(`${operation} failed:`, err)
  return res.status(500).json({
    success: false,
    error: `${operation} failed`,
    details: err?.message || "Unknown error",
  })
}

const parseJsonSafe = (value, fallback) => {
  try {
    if (value === null || value === undefined || value === "") return fallback
    if (typeof value === "object") return value
    return JSON.parse(value)
  } catch (_) {
    return fallback
  }
}

const validateRestaurantUid = async (restaurantUid) => {
  if (!restaurantUid || typeof restaurantUid !== "string" || restaurantUid.trim() === "") {
    throw new Error("Restaurant UID is required and must be a non-empty string")
  }
  const trimmedUid = restaurantUid.trim()
  try {
    const [rows] = await db.query("SELECT id, uid FROM restaurant_owners WHERE uid = ?", [trimmedUid])
    if (rows.length === 0) {
      throw new Error(`Restaurant not found for UID: ${trimmedUid}`)
    }
    return rows[0].id
  } catch (err) {
    throw new Error(`Failed to validate restaurant UID: ${err.message}`)
  }
}

const validateAddresses = (addresses) => {
  if (addresses === undefined) return []
  if (!Array.isArray(addresses)) {
    throw new Error("Addresses must be an array")
  }
  if (addresses.length > 3) {
    throw new Error("Maximum 3 addresses allowed")
  }
  return addresses.map((addr, i) => {
    if (typeof addr !== "string" || addr.trim() === "") {
      throw new Error(`Address at index ${i} must be a non-empty string`)
    }
    return addr.trim()
  })
}

const orderTimers = new Map() // Store order timers for cleanup

// Auto-reject function
const autoRejectOrder = async (orderId) => {
  try {
    console.log(`🕐 Auto-rejecting order ${orderId} due to timeout`)

    const [existing] = await db.query("SELECT * FROM orders WHERE id = ? AND status = ?", [orderId, "pending"])
    if (existing.length === 0) {
      console.log(`Order ${orderId} already processed or not found`)
      return
    }

    const order = existing[0]

    // Update order to rejected with auto_rejected flag
    await db.query("UPDATE orders SET status = ?, rejection_reason = ?, auto_rejected = TRUE WHERE id = ?", [
      "rejected",
      "Order was not accepted within the time limit",
      orderId,
    ])

    // Get updated order data
    const [updatedRows] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId])
    const updatedOrder = updatedRows[0]

    // Emit socket events
    io.to(`restaurant_${order.restaurant_uid}`).emit("orderAutoRejected", updatedOrder)
    io.to(`customer_${order.customer_uid}`).emit("orderStatusUpdated", updatedOrder)

    // Clean up timer reference
    orderTimers.delete(orderId)

    console.log(`✅ Order ${orderId} auto-rejected successfully`)
  } catch (err) {
    console.error(`❌ Error auto-rejecting order ${orderId}:`, err)
  }
}

app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok", now: new Date().toISOString() })
})

app.get("/health/db", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS ok")
    res.json({ success: true, db: rows[0].ok === 1 ? "reachable" : "unknown" })
  } catch (err) {
    handleError(res, err, "DB health check")
  }
})

app.get("/api/restaurants", async (req, res) => {
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
    `)

    const mapped = restaurants.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      email: r.email,
      is_online: r.is_online,
      is_pure_veg: r.is_pure_veg === 1, // Convert to boolean
      imageUrl: "",
      rating: 4.5,
      deliveryTime: "25-30 min",
      deliveryFee: 0,
      isOpen: r.is_online === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))

    res.json({ success: true, data: { restaurants: mapped } })
  } catch (err) {
    handleError(res, err, "fetching restaurants")
  }
})

app.post("/api/restaurants", async (req, res) => {
  const { uid, restaurant_name, location, email, is_pure_veg } = req.body

  if (!uid || !restaurant_name || !location || !email) {
    return res.status(400).json({
      success: false,
      error: "UID, restaurant name, location, and email are required",
    })
  }

  try {
    const trimmedUid = uid.trim()
    const [existing] = await db.query("SELECT uid FROM restaurant_owners WHERE uid = ? OR email = ?", [
      trimmedUid,
      email.trim(),
    ])

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Restaurant with this UID or email already exists",
      })
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

        0, // Default to offline
      ],
    )

    const [inserted] = await db.query("SELECT * FROM restaurant_owners WHERE id = ?", [result.insertId])

    res.status(201).json({
      success: true,
      message: "Restaurant registered successfully",
      restaurant: inserted[0],
      data: { restaurant: inserted[0] },
    })
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, error: "Restaurant with this email or UID already exists" })
    }
    handleError(res, err, "registering restaurant")
  }
})

app.get("/api/restaurants/:uid", async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim()
    const [rows] = await db.query("SELECT * FROM restaurant_owners WHERE uid = ?", [trimmedUid])

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    const restaurant = {
      ...rows[0],
      is_pure_veg: rows[0].is_pure_veg === 1, // Convert to boolean
      isOpen: rows[0].is_online === 1,
    }
    res.json({ success: true, restaurant, data: { restaurant } })
  } catch (err) {
    handleError(res, err, "fetching restaurant")
  }
})

app.put("/api/restaurants/:uid", async (req, res) => {
  const { restaurant_name, location, email, is_pure_veg } = req.body

  if (!restaurant_name || !location || !email || is_pure_veg === undefined) {
    return res.status(400).json({
      success: false,
      error: "Restaurant name, location, email, and is_pure_veg are required",
    })
  }

  try {
    const trimmedUid = req.params.uid.trim()
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET restaurant_name = ?, location = ?, email = ?, is_pure_veg = ?, updated_at = NOW()
       WHERE uid = ?`,
      [
        restaurant_name.trim(),
        location.trim(),
        email.trim(),
        is_pure_veg ? 1 : 0, // âœ… update column correctly
        trimmedUid,
      ],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    const [updated] = await db.query("SELECT * FROM restaurant_owners WHERE uid = ?", [trimmedUid])

    res.json({
      success: true,
      message: "Restaurant updated successfully",
      restaurant: updated[0],
      data: { restaurant: updated[0] },
    })
  } catch (err) {
    handleError(res, err, "updating restaurant")
  }
})

app.get("/api/restaurants/:uid/geo-location", async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim();
    const [rows] = await db.query(
      "SELECT location, latitude, longitude FROM restaurant_owners WHERE uid = ?",
      [trimmedUid]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    handleError(res, err, "fetching geo location");
  }
});
//lat&long update

app.put("/api/restaurants/:uid/geo-location", async (req, res) => {
  const {  latitude, longitude } = req.body;
  if ( latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      success: false,
      error: " latitude, and longitude are required",
    });
  }
  try {
    const trimmedUid = req.params.uid.trim();
    await validateRestaurantUid(trimmedUid);
    const [result] = await db.query(
      "UPDATE restaurant_owners SET  latitude = ?, longitude = ?, updated_at = NOW() WHERE uid = ?",
      [location.trim(), latitude, longitude, trimmedUid]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      });
    }
    res.json({
      success: true,
      message: "Geo location updated successfully",
    });
  } catch (err) {
    handleError(res, err, "updating geo location");
  }
});

app.put("/api/restaurants/:uid/status", async (req, res) => {
  const { is_online } = req.body
  if (is_online === undefined || is_online === null) {
    return res.status(400).json({
      success: false,
      error: "is_online field is required",
    })
  }
  try {
    const trimmedUid = req.params.uid.trim()
    const isOnlineValue = is_online ? 1 : 0
    console.log(`Updating restaurant ${trimmedUid} to is_online: ${isOnlineValue}`)
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET is_online = ?, updated_at = NOW()
       WHERE uid = ?`,
      [isOnlineValue, trimmedUid],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    const [updated] = await db.query("SELECT * FROM restaurant_owners WHERE uid = ?", [trimmedUid])
    console.log(`Restaurant ${trimmedUid} updated, is_online: ${updated[0].is_online}`)

    res.json({
      success: true,
      message: "Restaurant status updated successfully",
      restaurant: updated[0],
      data: { restaurant: updated[0] },
    })
  } catch (err) {
    handleError(res, err, "updating restaurant status")
  }
})

// Add this new endpoint after the existing /api/restaurants endpoint in server.js

app.get("/api/restaurants-with-menu-categories", async (req, res) => {
  try {
    const { category_id } = req.query

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
    `)

    let filteredRestaurants = restaurants

    // If category filter is applied, filter by menu items
    if (category_id) {
      const categoryKeywords = getCategoryKeywords(category_id)

      if (categoryKeywords.length > 0) {
        const keywordConditions = categoryKeywords
          .map(() => "(LOWER(m.name) LIKE ? OR LOWER(m.description) LIKE ? OR LOWER(m.category) LIKE ?)")
          .join(" OR ")

        const keywordParams = []
        categoryKeywords.forEach((keyword) => {
          const pattern = `%${keyword.toLowerCase()}%`
          keywordParams.push(pattern, pattern, pattern)
        })

        const [restaurantsWithMenuItems] = await db.query(
          `
          SELECT DISTINCT r.uid
          FROM restaurant_owners r
          JOIN menu_items1 m ON r.uid = m.restaurant_uid
          WHERE m.is_available = 1 AND m.is_deleted = 0 AND (${keywordConditions})
        `,
          keywordParams,
        )

        const validRestaurantIds = new Set(restaurantsWithMenuItems.map((r) => r.uid))
        filteredRestaurants = restaurants.filter((r) => validRestaurantIds.has(r.id))
      }
    }

    const mapped = filteredRestaurants.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      email: r.email,
      is_online: r.is_online,
      is_pure_veg: r.is_pure_veg === 1,
      imageUrl: "",
      rating: 4.5,
      deliveryTime: "25-30 min",
      deliveryFee: 0,
      isOpen: r.is_online === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))

    res.json({ success: true, data: { restaurants: mapped } })
  } catch (err) {
    handleError(res, err, "fetching restaurants with menu categories")
  }
})

// Add this helper function after the endpoint
function getCategoryKeywords(categoryId) {
  const categories = {
    chicken: ["chicken", "poultry", "tandoori", "butter chicken", "grilled chicken", "fried chicken"],
    pizza: ["pizza", "margherita", "pepperoni", "cheese pizza", "italian"],
    biryani: ["biryani", "pulao", "dum biryani", "hyderabadi", "lucknowi", "kolkata biriyani"],
    thali: [
      "thali",
      "complete meal",
      "unlimited",
      "gujarati",
      "rajasthani",
      "south indian thali",
      "north indian thali",
      "veg thali",
      "chicken thali",
      "mutton thali",
      "egg thali",
      "fish thali",
    ],
    chinese: ["chinese", "noodles", "fried rice", "manchurian", "chowmein", "hakka", "szechuan"],
    "north-indian": ["roti", "naan", "dal makhani", "paneer", "curry", "punjabi"],
    paneer: ["paneer", "cottage cheese", "palak paneer", "matar paneer", "kadai paneer"],
    "chole-bhatura": ["chole", "bhatura", "chickpea", "punjabi"],
  }
  return categories[categoryId] || []
}
app.get("/api/food-categories", (req, res) => {
  try {
    const categories = [
      {
        id: "chicken",
        name: "Chicken",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f414.png",
        searchKeywords: [
          "chicken",
          "poultry",
          "fried chicken",
          "grilled chicken",
          "tandoori",
          "butter chicken",
          "non-veg",
        ],
      },
      {
        id: "pizza",
        name: "Pizza",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f355.png",
        searchKeywords: ["pizza", "italian", "cheese", "margherita", "pepperoni", "dominos", "pizza hut"],
      },
      {
        id: "biryani",
        name: "Biryani",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35b.png",
        searchKeywords: ["biryani", "pulao", "rice", "hyderabadi", "lucknowi", "dum", "mutton", "chicken biryani"],
      },
      {
        id: "thali",
        name: "Thali",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f372.png",
        searchKeywords: ["thali", "gujarati", "rajasthani", "unlimited", "complete meal", "dal", "sabji"],
      },
      {
        id: "chinese",
        name: "Chinese",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35c.png",
        searchKeywords: ["chinese", "noodles", "fried rice", "manchurian", "chowmein", "hakka", "szechuan"],
      },
      {
        id: "north-indian",
        name: "North Indian",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f35b.png",
        searchKeywords: ["north indian", "punjabi", "roti", "naan", "dal makhani", "paneer", "curry"],
      },
      {
        id: "paneer",
        name: "Paneer",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9c0.png",
        searchKeywords: ["paneer", "cottage cheese", "palak paneer", "matar paneer", "kadai paneer", "vegetarian"],
      },
      {
        id: "chole-bhatura",
        name: "Chole Bhatura",
        imageUrl: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fad3.png",
        searchKeywords: ["chole", "bhatura", "punjabi", "chickpea", "spicy", "fried bread"],
      },
    ]

    res.json({
      success: true,
      data: { categories },
    })
  } catch (err) {
    handleError(res, err, "fetching food categories")
  }
})

app.get("/api/categories", async (req, res) => {
  try {
    const restaurantUid = req.query.restaurant_uid?.trim()
    await validateRestaurantUid(restaurantUid)

    const [rows] = await db.query("SELECT * FROM categories1 WHERE restaurant_uid = ? ORDER BY name", [restaurantUid])

    res.json({ success: true, categories: rows, data: { categories: rows } })
  } catch (err) {
    handleError(res, err, "fetching categories")
  }
})

app.post("/api/categories", async (req, res) => {
  const { name, restaurant_uid } = req.body

  if (!name || !restaurant_uid) {
    return res.status(400).json({
      success: false,
      error: "Name and restaurant UID are required",
    })
  }

  try {
    const trimmedUid = restaurant_uid.trim()
    await validateRestaurantUid(trimmedUid)

    const [result] = await db.query("INSERT INTO categories1 (name, restaurant_uid) VALUES (?, ?)", [
      name.trim(),
      trimmedUid,
    ])

    const [inserted] = await db.query("SELECT * FROM categories1 WHERE id = ?", [result.insertId])

    res.status(201).json({
      success: true,
      message: "Category added successfully",
      category: inserted[0],
      data: { category: inserted[0] },
    })
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        error: `Category "${req.body?.name}" already exists for restaurant UID: ${req.body?.restaurant_uid}`,
      })
    }
    handleError(res, err, "adding category")
  }
})

app.post("/api/menu", async (req, res) => {
  const { name, description, price, category, restaurant_uid, is_available = 1, image_url, food_type = 0 } = req.body
  if (!name || !category || !restaurant_uid || price === undefined || food_type === undefined) {
    return res.status(400).json({ success: false, error: "Missing required fields" })
  }
  try {
    await validateRestaurantUid(restaurant_uid)
    const [categoryExists] = await db.query("SELECT id FROM categories1 WHERE name = ? AND restaurant_uid = ?", [
      category,
      restaurant_uid,
    ])
    if (categoryExists.length === 0) {
      return res.status(400).json({ success: false, error: "Category does not exist" })
    }
    const [result] = await db.query(
      `INSERT INTO menu_items1 (name, description, price, category, restaurant_uid, is_available, image_url, food_type, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        name.trim(),
        description || null,
        Number(price),
        category,
        restaurant_uid,
        is_available ? 1 : 0,
        image_url || null,
        Number(food_type),
      ],
    )
    const [inserted] = await db.query("SELECT * FROM menu_items1 WHERE id = ?", [result.insertId])
    res.status(201).json({ success: true, message: "Menu item created", item: inserted[0] })
  } catch (err) {
    handleError(res, err, "creating menu item")
  }
})

app.get("/api/menu", async (req, res) => {
  const { restaurant_uid } = req.query
  if (!restaurant_uid || typeof restaurant_uid !== "string" || restaurant_uid.trim() === "") {
    return res.status(400).json({ success: false, error: "Restaurant UID is required" })
  }
  try {
    const trimmedUid = restaurant_uid.trim()
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
      [trimmedUid],
    )
    const mapped = items.map((item) => ({
      ...item,
      add_ons: parseJsonSafe(item.add_ons, []),
      is_available: item.is_available === 1,
      food_type: item.food_type, // Included as int (0 or 1)
    }))
    res.json({ success: true, data: { items: mapped } })
  } catch (err) {
    handleError(res, err, "fetching menu items")
  }
})

app.get("/api/menu/:id", async (req, res) => {
  const { id } = req.params
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
      [id],
    )
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: "Menu item not found" })
    }
    const item = items[0]
    const mappedItem = {
      ...item,
      add_ons: parseJsonSafe(item.add_ons, []),
      is_available: item.is_available === 1,
      food_type: item.food_type, // Included as int (0 or 1)
    }
    res.json({ success: true, data: { item: mappedItem } })
  } catch (err) {
    handleError(res, err, "fetching menu item")
  }
})

app.put("/api/menu/:id", async (req, res) => {
  const { name, description, price, category, restaurant_uid, is_available = 1, image_url, food_type = 0 } = req.body
  if (!name || !category || !restaurant_uid || price === undefined || food_type === undefined) {
    return res.status(400).json({ success: false, error: "Missing required fields" })
  }
  try {
    await validateRestaurantUid(restaurant_uid)
    const [categoryExists] = await db.query("SELECT id FROM categories1 WHERE name = ? AND restaurant_uid = ?", [
      category,
      restaurant_uid,
    ])
    if (categoryExists.length === 0) {
      return res.status(400).json({ success: false, error: "Category does not exist" })
    }
    const [result] = await db.query(
      `UPDATE menu_items1 SET name=?, description=?, price=?, category=?, is_available=?, image_url=?, food_type=?
       WHERE id=? AND restaurant_uid=? AND is_deleted=0`,
      [
        name.trim(),
        description || null,
        Number(price),
        category,
        is_available ? 1 : 0,
        image_url || null,
        Number(food_type),
        req.params.id,
        restaurant_uid,
      ],
    )
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, error: "Menu item not found or deleted" })
    const [updated] = await db.query("SELECT * FROM menu_items1 WHERE id=? AND is_deleted=0", [req.params.id])
    res.json({ success: true, message: "Menu item updated", item: updated[0] })
  } catch (err) {
    handleError(res, err, "updating menu item")
  }
})

app.patch("/api/menu/:id/availability", async (req, res) => {
  const { is_available } = req.body
  const restaurant_uid = req.query.restaurant_uid?.trim()
  if (is_available === undefined || !restaurant_uid) {
    return res.status(400).json({ success: false, error: "is_available and restaurant_uid are required" })
  }
  try {
    await validateRestaurantUid(restaurant_uid)
    const [result] = await db.query(
      `UPDATE menu_items1 SET is_available=? WHERE id=? AND restaurant_uid=? AND is_deleted=0`,
      [is_available ? 1 : 0, req.params.id, restaurant_uid],
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: "Menu item not found or deleted" })
    }
    res.json({ success: true, message: "Availability updated", is_available: is_available ? 1 : 0 })
  } catch (err) {
    handleError(res, err, "updating availability")
  }
})

app.delete("/api/menu/:id", async (req, res) => {
  const restaurant_uid = req.query.restaurant_uid?.trim()
  if (!restaurant_uid) {
    return res.status(400).json({ success: false, error: "Restaurant UID is required" })
  }
  try {
    await validateRestaurantUid(restaurant_uid)
    const [existing] = await db.query(
      "SELECT id FROM menu_items1 WHERE id = ? AND restaurant_uid = ? AND is_deleted = 0",
      [req.params.id, restaurant_uid],
    )
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: "Menu item not found or already deleted" })
    }
    const [result] = await db.query(
      `UPDATE menu_items1 SET is_deleted=1, is_available=0 WHERE id=? AND restaurant_uid=?`,
      [req.params.id, restaurant_uid],
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: "Menu item not found or already deleted" })
    }
    res.json({ success: true, message: "Menu item deleted" })
  } catch (err) {
    if (err.code === "ER_ROW_IS_REFERENCED_2") {
      return res
        .status(400)
        .json({ success: false, error: "Cannot delete menu item; it is referenced in existing orders" })
    }
    handleError(res, err, "deleting menu item")
  }
})

app.post("/api/customers", async (req, res) => {
  const { uid, name, email, phone, addresses } = req.body || {}

  if (!uid || !name || !email) {
    return res.status(400).json({ success: false, error: "UID, name, and email are required" })
  }

  try {
    const validatedAddresses = validateAddresses(addresses || [])

    const [existing] = await db.query("SELECT * FROM customers WHERE uid = ?", [uid])
    if (existing.length > 0) {
      await db.query(`UPDATE customers SET name = ?, email = ?, phone = ?, address = ? WHERE uid = ?`, [
        name,
        email,
        phone || "",
        JSON.stringify(validatedAddresses),
        uid,
      ])
      return res.json({ success: true, message: "Customer updated" })
    } else {
      await db.query(`INSERT INTO customers (uid, name, email, phone, address) VALUES (?, ?, ?, ?, ?)`, [
        uid,
        name,
        email,
        phone || "",
        JSON.stringify(validatedAddresses),
      ])
      return res.status(201).json({ success: true, message: "Customer registered" })
    }
  } catch (err) {
    handleError(res, err, "registering/updating customer")
  }
})

app.get("/api/customers/:uid", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM customers WHERE uid = ?", [req.params.uid])
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: "Customer not found" })
    }
    const customer = rows[0]
    customer.address = parseJsonSafe(customer.address, [])
    res.json({ success: true, data: { customer }, customer })
  } catch (err) {
    handleError(res, err, "fetching customer")
  }
})

app.post("/api/customers/:uid/addresses", async (req, res) => {
  try {
    const { address } = req.body || {}
    if (!address || typeof address !== "string" || address.trim() === "") {
      return res.status(400).json({ success: false, error: "Address must be a non-empty string" })
    }

    const [rows] = await db.query("SELECT address FROM customers WHERE uid = ?", [req.params.uid])
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Customer not found" })

    const current = parseJsonSafe(rows[0].address, [])
    if (!Array.isArray(current)) return res.status(500).json({ success: false, error: "Invalid stored address format" })

    if (current.length >= 3) {
      return res.status(400).json({ success: false, error: "Maximum 3 addresses allowed" })
    }

    current.push(address.trim())
    await db.query("UPDATE customers SET address = ? WHERE uid = ?", [JSON.stringify(current), req.params.uid])

    res.json({ success: true, message: "Address added", data: { addresses: current } })
  } catch (err) {
    handleError(res, err, "adding address")
  }
})

app.delete("/api/customers/:uid/addresses/:index", async (req, res) => {
  try {
    const idx = Number.parseInt(req.params.index, 10)
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ success: false, error: "Invalid index" })

    const [rows] = await db.query("SELECT address FROM customers WHERE uid = ?", [req.params.uid])
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Customer not found" })

    const current = parseJsonSafe(rows[0].address, [])
    if (!Array.isArray(current)) return res.status(500).json({ success: false, error: "Invalid stored address format" })
    if (idx >= current.length) return res.status(400).json({ success: false, error: "Index out of range" })

    current.splice(idx, 1)
    await db.query("UPDATE customers SET address = ? WHERE uid = ?", [JSON.stringify(current), req.params.uid])

    res.json({ success: true, message: "Address removed", data: { addresses: current } })
  } catch (err) {
    handleError(res, err, "removing address")
  }
})

// Add this new endpoint after the existing customer endpoints in server.js
app.put("/api/customers/:uid/addresses-only", async (req, res) => {
  const { addresses } = req.body

  if (!addresses || !Array.isArray(addresses)) {
    return res.status(400).json({
      success: false,
      error: "Addresses must be provided as an array",
    })
  }

  if (addresses.length > 3) {
    return res.status(400).json({
      success: false,
      error: "Maximum 3 addresses allowed",
    })
  }

  try {
    const trimmedUid = req.params.uid.trim()

    // Validate that customer exists
    const [customerCheck] = await db.query("SELECT uid FROM customers WHERE uid = ?", [trimmedUid])

    if (customerCheck.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Customer not found. Please complete your profile first.",
      })
    }

    // Update only the addresses field
    const [result] = await db.query("UPDATE customers SET address = ? WHERE uid = ?", [
      JSON.stringify(addresses),
      trimmedUid,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Failed to update addresses",
      })
    }

    res.json({
      success: true,
      message: "Addresses updated successfully",
      data: { addresses },
    })
  } catch (err) {
    handleError(res, err, "updating addresses")
  }
})

/
// Replace the existing /api/orders endpoint in server1.js
app.post("/api/orders", async (req, res) => {
  const {
    customer_uid,
    restaurant_uid,
    items,
    delivery_address,
    payment_method,
    notes,
    customer_name,
    phone_number,
    subtotal,
    delivery_fee,
    packing_fee,
    gst_amount,
    platform_fee,
    total_amount,
    delivery_coordinates,
    location_accuracy = 'address_only'
  } = req.body || {};

  // Validate required fields
  if (
    !customer_uid ||
    !restaurant_uid ||
    !items ||
    !delivery_address ||
    !payment_method ||
    !customer_name ||
    !phone_number ||
    total_amount === undefined
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields including total_amount",
    });
  }

  // Validate phone number
  if (!/^\+?[0-9]{10,15}$/.test(phone_number)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number format",
    });
  }

  // Validate coordinates
  let latitude = null;
  let longitude = null;
  if (delivery_coordinates && typeof delivery_coordinates === "object") {
    latitude = delivery_coordinates.latitude;
    longitude = delivery_coordinates.longitude;
    if (latitude !== null && longitude !== null) {
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        return res.status(400).json({
          success: false,
          error: "Invalid coordinate format - must be numbers",
        });
      }
      if (latitude < -90 || latitude > 90) {
        return res.status(400).json({
          success: false,
          error: "Invalid latitude - must be between -90 and 90",
        });
      }
      if (longitude < -180 || longitude > 180) {
        return res.status(400).json({
          success: false,
          error: "Invalid longitude - must be between -180 and 180",
        });
      }
    }
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Validate restaurant exists & online
    const [restaurant] = await connection.query("SELECT * FROM restaurant_owners WHERE uid = ?", [restaurant_uid]);
    if (restaurant.length === 0) throw new Error("Restaurant not found");
    if (restaurant[0].is_online !== 1) throw new Error("Restaurant is currently offline");

    // Validate customer exists
    const [customer] = await connection.query("SELECT * FROM customers WHERE uid = ?", [customer_uid]);
    if (customer.length === 0) throw new Error("Customer not found");

    // Calculate subtotal validation
    let calculatedSubtotal = 0;
    for (const item of items) {
      const [menuItem] = await connection.query(
        "SELECT * FROM menu_items1 WHERE id = ? AND restaurant_uid = ? AND is_available = 1 AND is_deleted = 0",
        [item.menu_item_id, restaurant_uid]
      );
      if (menuItem.length === 0) throw new Error(`Menu item ${item.menu_item_id} not found or unavailable`);
      calculatedSubtotal += Number(menuItem[0].price) * Number(item.quantity);
    }

    if (Math.abs(calculatedSubtotal - (subtotal || 0)) > 0.01) {
      throw new Error(`Subtotal mismatch: expected ₹${calculatedSubtotal.toFixed(2)}, received ₹${(subtotal || 0).toFixed(2)}`);
    }

    // Verify fee breakdown
    const expectedDeliveryFee = calculatedSubtotal >= 500 ? 0 : 0;
    const expectedPackingFee = 0;
    const expectedGst = calculatedSubtotal * 0.05;
    const expectedPlatformFee = 0;
    const expectedTotal = calculatedSubtotal + expectedDeliveryFee + expectedPackingFee + expectedGst + expectedPlatformFee;

    if (Math.abs(expectedTotal - total_amount) > 0.02) {
      throw new Error(`Total mismatch: expected ₹${expectedTotal.toFixed(2)}, received ₹${total_amount.toFixed(2)}`);
    }

    const responseDeadline = new Date(Date.now() + 10000);

    // Create order in DB with payment pending
    const [orderResult] = await connection.query(
      `INSERT INTO orders 
        (customer_uid, restaurant_uid, customer_name, phone_number, status, total_price, 
         delivery_address, delivery_latitude, delivery_longitude, location_accuracy, 
         payment_method, notes, payment_status, response_deadline)
       VALUES (?, ?, ?, ?, 'payment_pending', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        customer_uid,
        restaurant_uid,
        customer_name,
        phone_number,
        total_amount,
        delivery_address,
        latitude,
        longitude,
        location_accuracy,
        payment_method,
        notes || null,
        responseDeadline,
      ]
    );

    const orderId = orderResult.insertId;

    for (const item of items) {
      await connection.query("INSERT INTO order_items (order_id, menu_item_id, quantity) VALUES (?, ?, ?)", [
        orderId,
        item.menu_item_id,
        item.quantity,
      ]);
    }

    // 🔹 Create Cashfree Payment
    try {
      const cashfreeResponse = await axios.post(
        "https://api.cashfree.com/pg/orders",
        {
          order_id: `order_${orderId}`,
          order_amount: total_amount,
          order_currency: "INR",
          customer_details: {
            customer_id: customer_uid,
            customer_name,
            customer_phone: phone_number,
            customer_email: customer[0].email || "customer@example.com",
          },
          order_meta: {
            return_url: `https://khawwws.onrender.com/payment-success?order_id=${orderId}`,
            notify_url: `https://khawwws.onrender.com/api/cashfree/webhook`,
          },
          order_note: notes || "Food order",
        },
        {
          headers: {
            "x-api-version": "2023-08-01",
            "x-client-id": process.env.CASHFREE_APP_ID,
            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
            "Content-Type": "application/json",
          },
        }
      );

      const { payment_session_id, cf_order_id } = cashfreeResponse.data;

      await connection.query("UPDATE orders SET payment_session_id = ?, payment_id = ? WHERE id = ?", [
        payment_session_id,
        cf_order_id,
        orderId,
      ]);

      await connection.commit();

      // ✅ Do NOT notify restaurant yet.
      // Payment verification (via webhook or verify-payment endpoint) will handle restaurant notifications.

      res.status(201).json({
        success: true,
        message: "Order created, proceed to payment",
        data: {
          order_id: orderId,
          payment_session_id,
          total_amount: total_amount,
          webhook_url: "https://khawwws.onrender.com/api/cashfree/webhook",
          response_deadline: responseDeadline.toISOString(),
          delivery_coordinates: latitude && longitude ? { latitude, longitude } : null,
          location_accuracy,
          breakdown: {
            subtotal: calculatedSubtotal,
            delivery_fee: expectedDeliveryFee,
            packing_fee: expectedPackingFee,
            gst_amount: expectedGst,
            platform_fee: expectedPlatformFee,
          },
        },
      });
    } catch (cashfreeError) {
      console.error("Cashfree API Error:", cashfreeError.response?.data || cashfreeError.message);

      await connection.query("UPDATE orders SET status = ?, payment_status = ? WHERE id = ?", [
        "cancelled",
        "failed",
        orderId,
      ]);

      await connection.commit();

      return res.status(500).json({
        success: false,
        error: "Payment processing unavailable. Please try again.",
        details: cashfreeError.response?.data?.message || "Payment gateway error",
      });
    }
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Order creation error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to create order",
    });
  } finally {
    if (connection) connection.release();
  }
});



// Add payment verification endpoint
app.post("/api/orders/:orderId/verify-payment", async (req, res) => {
  const { orderId } = req.params;

  console.log("\n\n");
  console.log("████████████████████████████████████████████████████████████");
  console.log("█            VERIFY-PAYMENT ENDPOINT CALLED                █");
  console.log("████████████████████████████████████████████████████████████");
  console.log(`📋 Order ID: ${orderId}`);
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log("────────────────────────────────────────────────────────────");

  try {
    // Fetch order from database
    const [orders] = await db.query(
      "SELECT * FROM orders WHERE id = ?", 
      [orderId]
    );
    
    if (orders.length === 0) {
      console.log("❌ ORDER NOT FOUND IN DATABASE");
      console.log("████████████████████████████████████████████████████████████\n");
      return res.status(404).json({ 
        success: false, 
        error: "Order not found" 
      });
    }

    const order = orders[0];

    console.log("💾 Current Database State:");
    console.log(`   Order ID: ${order.id}`);
    console.log(`   Payment ID: ${order.payment_id}`);
    console.log(`   Order Status: ${order.status}`);
    console.log(`   Payment Status: ${order.payment_status}`);
    console.log(`   Total Amount: ₹${order.total_price}`);
    console.log(`   Customer: ${order.customer_name}`);
    console.log(`   Created: ${order.created_at}`);
    console.log("────────────────────────────────────────────────────────────");

    // Check if already processed
    if (order.payment_status === 'success') {
      console.log("⚠️  PAYMENT ALREADY VERIFIED");
      console.log("   Skipping duplicate processing");
      console.log("████████████████████████████████████████████████████████████\n");
      
      return res.json({
        success: true,
        message: "Payment already verified",
        data: { 
          order_status: "pending",
          payment_status: "success",
          note: "Payment was previously verified"
        },
      });
    }

    // Check if already failed
    if (order.payment_status === 'failed' || order.payment_status === 'cancelled') {
      console.log("❌ PAYMENT ALREADY MARKED AS FAILED/CANCELLED");
      console.log(`   Current status: ${order.payment_status}`);
      console.log("████████████████████████████████████████████████████████████\n");
      
      return res.json({
        success: false,
        message: "Payment has already failed",
        data: { 
          order_status: order.status,
          payment_status: order.payment_status
        },
      });
    }

    // Call Cashfree API to verify payment
    console.log("📡 Calling Cashfree API...");
    console.log(`   Endpoint: https://api.cashfree.com/pg/orders/${order.payment_id}/payments`);
    console.log(`   App ID: ${process.env.CASHFREE_APP_ID?.substring(0, 10)}...`);
    
    let verifyResponse;
    try {
      verifyResponse = await axios.get(
        `https://api.cashfree.com/pg/orders/${order.payment_id}/payments`, 
        {
          headers: {
            "x-api-version": "2023-08-01",
            "x-client-id": process.env.CASHFREE_APP_ID,
            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
          },
        }
      );

      console.log("────────────────────────────────────────────────────────────");
      console.log("✅ Cashfree API Response Received");
      console.log(`   Status Code: ${verifyResponse.status}`);
      console.log(`   Number of Payments: ${verifyResponse.data?.length || 0}`);
      console.log("────────────────────────────────────────────────────────────");
      console.log("📄 Full Payment Details:");
      console.log(JSON.stringify(verifyResponse.data, null, 2));
      console.log("────────────────────────────────────────────────────────────");

    } catch (apiError) {
      console.log("────────────────────────────────────────────────────────────");
      console.log("❌ CASHFREE API ERROR");
      console.log(`   Status: ${apiError.response?.status}`);
      console.log(`   Message: ${apiError.response?.data?.message || apiError.message}`);
      console.log("   Full Error:", JSON.stringify(apiError.response?.data, null, 2));
      console.log("████████████████████████████████████████████████████████████\n");
      
      return res.status(500).json({
        success: false,
        error: "Unable to verify payment with payment gateway",
        details: apiError.response?.data?.message || apiError.message
      });
    }

    const payments = verifyResponse.data;
    
    // Log each payment attempt
    if (Array.isArray(payments) && payments.length > 0) {
      console.log("🔍 Analyzing Payment Attempts:");
      payments.forEach((payment, index) => {
        console.log(`   Payment ${index + 1}:`);
        console.log(`      Status: ${payment.payment_status}`);
        console.log(`      Amount: ₹${payment.payment_amount}`);
        console.log(`      Method: ${payment.payment_method}`);
        console.log(`      Time: ${payment.payment_time || 'N/A'}`);
        console.log(`      Message: ${payment.payment_message || 'N/A'}`);
      });
      console.log("────────────────────────────────────────────────────────────");
    } else {
      console.log("⚠️  NO PAYMENT ATTEMPTS FOUND");
      console.log("   This means customer may not have completed payment");
      console.log("────────────────────────────────────────────────────────────");
    }

    const successfulPayment = payments.find((p) => p.payment_status === "SUCCESS");

    if (!successfulPayment) {
      console.log("❌ NO SUCCESSFUL PAYMENT FOUND");
      console.log("   Marking order as FAILED in database");
      
      // Update database
      await db.query(
        "UPDATE orders SET status = ?, payment_status = ? WHERE id = ?", 
        ["cancelled", "failed", orderId]
      );

      console.log("✅ Database Updated:");
      console.log("   Order Status: cancelled");
      console.log("   Payment Status: failed");
      console.log("████████████████████████████████████████████████████████████\n");

      return res.json({
        success: false,
        message: "Payment verification failed - No successful payment found",
        data: { 
          order_status: "cancelled",
          payment_status: "failed",
          payment_attempts: payments.length,
          last_status: payments[0]?.payment_status || 'NONE'
        },
      });
    }

    // Payment successful - validate amount
    const paidAmount = parseFloat(successfulPayment.payment_amount);
    const orderAmount = parseFloat(order.total_price);
    
    console.log("✅ SUCCESSFUL PAYMENT FOUND");
    console.log(`   Paid Amount: ₹${paidAmount.toFixed(2)}`);
    console.log(`   Expected Amount: ₹${orderAmount.toFixed(2)}`);
    console.log(`   Difference: ₹${Math.abs(paidAmount - orderAmount).toFixed(2)}`);
    
    if (Math.abs(paidAmount - orderAmount) > 0.02) {
      console.log("❌ AMOUNT MISMATCH - SECURITY ALERT!");
      console.log("   Marking order as FAILED");
      
      await db.query(
        "UPDATE orders SET status = ?, payment_status = ? WHERE id = ?", 
        ["cancelled", "failed", orderId]
      );

      console.log("████████████████████████████████████████████████████████████\n");
      
      return res.status(400).json({
        success: false,
        error: "Payment amount mismatch",
        data: { 
          order_status: "cancelled",
          payment_status: "failed"
        },
      });
    }

    // All validations passed - update order
    console.log("✅ ALL VALIDATIONS PASSED");
    console.log("   Updating order to PENDING status");
    
    await db.query(
      "UPDATE orders SET status = ?, payment_status = ? WHERE id = ?", 
      ["pending", "success", orderId]
    );

    const [[updatedOrder]] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId]);

    console.log("────────────────────────────────────────────────────────────");
    console.log("📢 Notifying Restaurant");
    console.log(`   Restaurant UID: ${order.restaurant_uid}`);
    
    // Notify restaurant
    io.to(`restaurant_${order.restaurant_uid}`).emit("newOrder", updatedOrder);

    // Send FCM notification
    try {
      await sendFCMNotification(
        order.restaurant_uid,
        `New Order #${orderId}`,
        `Payment verified: ₹${orderAmount.toFixed(2)}. Please accept or reject.`,
        {
          type: "newOrder",
          orderId: orderId.toString(),
          status: "pending",
          paymentVerified: "true",
        }
      );
      console.log("   ✅ FCM Notification Sent");
    } catch (notifyErr) {
      console.log("   ❌ FCM Notification Failed:", notifyErr.message);
    }

    console.log("████████████████████████████████████████████████████████████");
    console.log("█              VERIFICATION COMPLETED                      █");
    console.log("█              STATUS: SUCCESS                             █");
    console.log("████████████████████████████████████████████████████████████\n");

    return res.json({
      success: true,
      message: "Payment verified successfully",
      data: { 
        order_status: "pending",
        payment_status: "success",
        amount_verified: orderAmount
      },
    });

  } catch (err) {
    console.log("────────────────────────────────────────────────────────────");
    console.log("❌ UNEXPECTED ERROR");
    console.log("   Error:", err.message);
    console.log("   Stack:", err.stack);
    console.log("████████████████████████████████████████████████████████████\n");
    
    return res.status(500).json({
      success: false,
      error: "Failed to verify payment",
      details: err.message
    });
  }
});

// Fix the endpoint path - it was missing /api/
app.get("/api/orders/:orderId/status", async (req, res) => {
  try {
    const { orderId } = req.params

    // Get order from database first
    const [orders] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId])

    if (orders.length === 0) {
      return res.status(404).json({
        error: "Order not found",
        status: "NOT_FOUND",
      })
    }

    const order = orders[0]

    // Return order status with payment_status
    return res.json({
      status: order.status || "PENDING",
      payment_status: order.payment_status || "pending",
      order: order,
    })
  } catch (error) {
    console.error("Order status check error:", error)
    res.status(500).json({
      error: "Failed to check order status",
      message: error.message,
    })
  }
})
app.options(
  "/api/cashfree/webhook",
  cors({
    origin: ["https://sandbox.cashfree.com", "https://api.cashfree.com"],
    credentials: true,
  }),
)

// Add this middleware BEFORE your webhook endpoint to capture raw body
app.use("/api/cashfree/webhook", (req, res, next) => {
  // Log incoming webhook for debugging
  console.log("Webhook received from:", req.get("origin") || req.get("x-forwarded-for") || req.connection.remoteAddress)
  console.log("Webhook URL hit:", req.originalUrl)
  next()
})

// Fixed Webhook Endpoint - Replace your existing one
app.post("/api/cashfree/webhook", async (req, res) => {
  const timestamp = new Date().toISOString();
  
  console.log("\n\n");
  console.log("████████████████████████████████████████████████████████████");
  console.log("█                 WEBHOOK TRIGGERED                        █");
  console.log("████████████████████████████████████████████████████████████");
  console.log(`⏰ Timestamp: ${timestamp}`);
  console.log(`🌐 Origin: ${req.get("origin") || req.get("x-forwarded-for") || req.connection.remoteAddress}`);
  console.log(`📍 URL: ${req.originalUrl}`);
  console.log(`📋 Method: ${req.method}`);
  console.log("────────────────────────────────────────────────────────────");
  console.log("📨 Headers:");
  console.log(JSON.stringify(req.headers, null, 2));
  console.log("────────────────────────────────────────────────────────────");
  console.log("📦 Raw Body Type:", typeof req.body);
  console.log("📦 Raw Body:", JSON.stringify(req.body, null, 2));
  console.log("████████████████████████████████████████████████████████████\n");
  console.log("🔔 Webhook received");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  try {
    // Handle test webhooks
    if (!req.body || Object.keys(req.body).length === 0) {
      console.log("Empty webhook - probably a test");
      return res.status(200).json({
        success: true,
        message: "Webhook endpoint is working",
      });
    }

    // Parse payload
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString());
    } else if (typeof req.body === "string") {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }

    console.log("📦 Parsed payload:", JSON.stringify(payload, null, 2));

    // Extract order ID
    let orderId = null;
    if (payload?.data?.order?.order_id) {
      orderId = payload.data.order.order_id.toString().replace("order_", "");
    } else if (payload?.order?.order_id) {
      orderId = payload.order.order_id.toString().replace("order_", "");
    } else if (payload?.order_id) {
      orderId = payload.order_id.toString().replace("order_", "");
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

    // Extract payment amount
    let paymentAmount = null;
    if (payload?.data?.payment?.payment_amount) {
      paymentAmount = parseFloat(payload.data.payment.payment_amount);
    } else if (payload?.payment?.payment_amount) {
      paymentAmount = parseFloat(payload.payment.payment_amount);
    } else if (payload?.data?.order?.order_amount) {
      paymentAmount = parseFloat(payload.data.order.order_amount);
    }

    console.log(`🔍 Extracted - Order ID: ${orderId}, Payment Status: ${paymentStatus}, Amount: ${paymentAmount}`);

    if (!orderId) {
      console.error("❌ No order ID found in webhook");
      return res.status(200).json({ success: true, error: "No order ID found" });
    }

    // Fetch order from database
    const [orders] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId]);
    
    if (orders.length === 0) {
      console.error(`❌ Order ${orderId} not found in database`);
      return res.status(200).json({ success: true, error: "Order not found" });
    }

    const order = orders[0];

    // 🔒 SECURITY CHECK 1: If payment already processed, don't process again
    if (order.payment_status === 'success') {
      console.log(`⚠️ Order ${orderId} payment already processed via webhook, skipping`);
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        orderId: orderId,
      });
    }

    // Determine payment status mapping
    let dbPaymentStatus = "pending";
    let dbOrderStatus = "payment_pending";
    let shouldNotifyRestaurant = false;

    if (paymentStatus === "SUCCESS" || paymentStatus === "PAID") {
      // 🔒 SECURITY CHECK 2: Validate payment amount and other criteria
      if (paymentAmount) {
        const validation = await validatePaymentSecurity(
          order, 
          paymentAmount, 
          paymentStatus
        );

        if (!validation.valid) {
          console.error(`❌ Payment validation failed for order ${orderId}: ${validation.reason}`);
          
          // If already processed by verify-payment endpoint, just acknowledge
          if (validation.alreadyProcessed) {
            return res.status(200).json({
              success: true,
              message: "Payment already processed",
              orderId: orderId,
            });
          }
          
          // Payment validation failed - mark as failed
          dbPaymentStatus = "failed";
          dbOrderStatus = "cancelled";
          shouldNotifyRestaurant = false;
        } else {
          // ✅ Payment validated successfully
          dbPaymentStatus = "success";
          dbOrderStatus = "pending";
          shouldNotifyRestaurant = true;
        }
      } else {
        console.warn(`⚠️ Payment amount not found in webhook for order ${orderId}, proceeding cautiously`);
        dbPaymentStatus = "success";
        dbOrderStatus = "pending";
        shouldNotifyRestaurant = true;
      }
    } else if (paymentStatus === "FAILED") {
      dbPaymentStatus = "failed";
      dbOrderStatus = "cancelled";
      shouldNotifyRestaurant = false;
    } else if (paymentStatus === "CANCELLED") {
      dbPaymentStatus = "cancelled";
      dbOrderStatus = "cancelled";
      shouldNotifyRestaurant = false;
    }

    console.log(
      `💾 Updating DB - Order: ${orderId}, Payment Status: ${dbPaymentStatus}, Order Status: ${dbOrderStatus}, Notify Restaurant: ${shouldNotifyRestaurant}`
    );

    // Update database
    const [result] = await db.query(
      "UPDATE orders SET payment_status = ?, status = ? WHERE id = ?", 
      [dbPaymentStatus, dbOrderStatus, orderId]
    );

    if (result.affectedRows > 0) {
      console.log(`✅ Order ${orderId} updated successfully`);

      // Get updated order
      const [updatedOrder] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId]);
      
      if (updatedOrder.length > 0) {
        const orderData = updatedOrder[0];

        // 🎯 Only notify restaurant if payment is verified and valid
        if (shouldNotifyRestaurant && dbPaymentStatus === "success") {
          // Check if restaurant is online and has notifications enabled
          const [restaurantStatus] = await db.query(
            `SELECT ro.is_online, COALESCE(rp.order_notifications, 1) as order_notifications
             FROM restaurant_owners ro
             LEFT JOIN restaurant_preferences rp ON ro.uid = rp.restaurant_uid
             WHERE ro.uid = ?`,
            [orderData.restaurant_uid]
          );

          if (
            restaurantStatus.length > 0 &&
            restaurantStatus[0].is_online === 1 &&
            restaurantStatus[0].order_notifications === 1
          ) {
            // Set up auto-reject timer (90 seconds)
            const timer = setTimeout(() => {
              autoRejectOrder(orderId);
            }, 90000);

            orderTimers.set(orderId, timer);

            // Emit to restaurant
            io.to(`restaurant_${orderData.restaurant_uid}`).emit("newOrder", {
              ...orderData,
              response_deadline: orderData.response_deadline,
              seconds_remaining: 90,
            });

            // Send FCM notification
            try {
              await sendFCMNotification(
                orderData.restaurant_uid,
                `New Order #${orderId}`,
                `Payment verified: ₹${orderData.total_price.toFixed(2)}`,
                {
                  type: "newOrder",
                  orderId: orderId.toString(),
                  status: "pending",
                  paymentVerified: "true",
                }
              );
            } catch (notifyErr) {
              console.error("Failed to send FCM notification:", notifyErr);
            }

            console.log(`🎯 Restaurant ${orderData.restaurant_uid} notified about order ${orderId}`);
          } else {
            console.log(`⚠️ Restaurant offline or notifications disabled for order ${orderId}`);
            await db.query(
              "UPDATE orders SET status = 'pending_restaurant_online' WHERE id = ?", 
              [orderId]
            );
          }
        } else if (!shouldNotifyRestaurant && dbPaymentStatus === "failed") {
          console.log(`❌ Payment validation failed - Restaurant NOT notified for order ${orderId}`);
        }

        // Always emit to customer about order status
        io.to(`customer_${orderData.customer_uid}`).emit("orderStatusUpdated", orderData);
      }
    } else {
      console.log(`⚠️ No order found with ID ${orderId}`);
    }

    return res.status(200).json({
      success: true,
      message: "Webhook processed",
      orderId: orderId,
      paymentStatus: dbPaymentStatus,
      restaurantNotified: shouldNotifyRestaurant,
    });

  } catch (err) {
    console.error("💥 Webhook Error:", err);
    // Always return 200 to prevent webhook retries
    return res.status(200).json({
      success: false,
      error: err.message,
      message: "Webhook received but processing failed",
    });
  }
});

// Add a GET endpoint for webhook testing
app.get("/api/cashfree/webhook", (req, res) => {
  res.json({
    success: true,
    message: "Cashfree webhook endpoint is active",
    timestamp: new Date().toISOString(),
  })
})



app.get("/api/orders", async (req, res) => {
  const { customer_uid } = req.query
  if (!customer_uid) {
    return res.status(400).json({ success: false, error: "Customer UID is required" })
  }
  try {
    const [orders] = await db.query(`SELECT * FROM orders WHERE customer_uid = ? ORDER BY created_at DESC`, [
      customer_uid,
    ])
    res.json({ success: true, data: { orders } })
  } catch (err) {
    handleError(res, err, "fetching customer orders")
  }
})

app.get("/api/customers/:uid/orders", async (req, res) => {
  const { uid } = req.params
  try {
    const [orders] = await db.query(`SELECT * FROM orders WHERE customer_uid = ? ORDER BY created_at DESC`, [uid])

    if (orders.length === 0) {
      return res.json({ success: true, data: { orders: [] } })
    }

    const orderIds = orders.map((o) => o.id)
    const [items] = await db.query(
      `SELECT oi.*, m.name AS item_name, m.price AS unit_price
       FROM order_items oi
       JOIN menu_items1 m ON oi.menu_item_id = m.id
       WHERE oi.order_id IN (?)`,
      [orderIds],
    )

    const ordersWithItems = orders.map((order) => {
      const its = items.filter((it) => it.order_id === order.id)
      return { ...order, items: its }
    })

    res.json({ success: true, data: { orders: ordersWithItems } })
  } catch (err) {
    handleError(res, err, "fetching customer orders")
  }
})

app.get("/api/orders/:id", async (req, res) => {
  const orderId = req.params.id
  try {
    const [orders] = await db.query(`SELECT * FROM orders WHERE id = ?`, [orderId])
    if (orders.length === 0) {
      return res.status(404).json({ success: false, error: "Order not found" })
    }
    const [items] = await db.query(
      `SELECT oi.*, m.name AS item_name, m.price AS unit_price
       FROM order_items oi
       JOIN menu_items1 m ON oi.menu_item_id = m.id
       WHERE oi.order_id = ?`,
      [orderId],
    )
    res.json({ success: true, data: { order: orders[0], items } })
  } catch (err) {
    handleError(res, err, "fetching order details")
  }
})

app.put("/api/orders/:id/accept", async (req, res) => {
  const orderId = req.params.id
  const restaurant_uid = req.query.restaurant_uid?.trim()

  if (!restaurant_uid) {
    return res.status(400).json({
      success: false,
      error: "Restaurant UID is required",
    })
  }

  try {
    await validateRestaurantUid(restaurant_uid)

    // Check if order exists and is in pending status
    const [existing] = await db.query("SELECT * FROM orders WHERE id = ? AND restaurant_uid = ? AND status = ?", [
      orderId,
      restaurant_uid,
      "pending",
    ])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found, not yours, or already processed",
      })
    }

    // Clear the auto-reject timer
    if (orderTimers.has(Number.parseInt(orderId))) {
      clearTimeout(orderTimers.get(Number.parseInt(orderId)))
      orderTimers.delete(Number.parseInt(orderId))
      console.log(`⏰ Cleared timer for order ${orderId}`)
    }

    // Update order status to preparing
    const [result] = await db.query("UPDATE orders SET status = ? WHERE id = ?", ["preparing", orderId])

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Failed to accept order",
      })
    }

    // Get updated order
    const [updatedRows] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId])
    const updatedOrder = updatedRows[0]

    // Emit socket events
    io.to(`restaurant_${restaurant_uid}`).emit("orderAccepted", updatedOrder)
    io.to(`customer_${updatedOrder.customer_uid}`).emit("orderStatusUpdated", updatedOrder)

    res.json({
      success: true,
      message: "Order accepted successfully",
      data: { order: updatedOrder },
    })

    console.log(`✅ Order ${orderId} accepted by restaurant ${restaurant_uid}`)
  } catch (err) {
    console.error(`❌ Error accepting order ${orderId}:`, err)
    handleError(res, err, "accepting order")
  }
})

// NEW ENDPOINT: Reject Order
app.put("/api/orders/:id/reject", async (req, res) => {
  const orderId = req.params.id
  const { rejection_reason } = req.body
  const restaurant_uid = req.query.restaurant_uid?.trim()

  if (!restaurant_uid) {
    return res.status(400).json({
      success: false,
      error: "Restaurant UID is required",
    })
  }

  if (!rejection_reason || rejection_reason.trim() === "") {
    return res.status(400).json({
      success: false,
      error: "Rejection reason is required",
    })
  }

  try {
    await validateRestaurantUid(restaurant_uid)

    // Check if order exists and is in pending status
    const [existing] = await db.query("SELECT * FROM orders WHERE id = ? AND restaurant_uid = ? AND status = ?", [
      orderId,
      restaurant_uid,
      "pending",
    ])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found, not yours, or already processed",
      })
    }

    // Clear the auto-reject timer
    if (orderTimers.has(Number.parseInt(orderId))) {
      clearTimeout(orderTimers.get(Number.parseInt(orderId)))
      orderTimers.delete(Number.parseInt(orderId))
      console.log(`⏰ Cleared timer for order ${orderId}`)
    }

    // Update order status to rejected with reason
    const [result] = await db.query(
      "UPDATE orders SET status = ?, rejection_reason = ?, auto_rejected = FALSE WHERE id = ?",
      ["rejected", rejection_reason.trim(), orderId],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Failed to reject order",
      })
    }

    // Get updated order
    const [updatedRows] = await db.query("SELECT * FROM orders WHERE id = ?", [orderId])
    const updatedOrder = updatedRows[0]

    // Emit socket events
    io.to(`restaurant_${restaurant_uid}`).emit("orderRejected", updatedOrder)
    io.to(`customer_${updatedOrder.customer_uid}`).emit("orderStatusUpdated", updatedOrder)

    // TODO: Process refund via Cashfree API here
    console.log(`💰 Should process refund for order ${orderId} - Amount: ₹${updatedOrder.total_price}`)

    res.json({
      success: true,
      message: "Order rejected successfully",
      data: { order: updatedOrder },
    })

    console.log(`❌ Order ${orderId} rejected by restaurant ${restaurant_uid}: ${rejection_reason}`)
  } catch (err) {
    console.error(`❌ Error rejecting order ${orderId}:`, err)
    handleError(res, err, "rejecting order")
  }
})

app.get("/api/restaurants/:restaurant_uid/orders", async (req, res) => {
  const { restaurant_uid } = req.params
  const { status, limit } = req.query
  try {
    await validateRestaurantUid(restaurant_uid)
    let query = `SELECT * FROM orders WHERE restaurant_uid = ?`
    const params = [restaurant_uid]
    if (status) {
      query += ` AND status = ?`
      params.push(status)
    }
    query += ` ORDER BY created_at DESC`
    if (limit) {
      query += ` LIMIT ?`
      params.push(Number.parseInt(limit))
    }
    const [orders] = await db.query(query, params)
    const ordersWithItems = await Promise.all(
      orders.map(async (order) => {
        const [items] = await db.query(
          `SELECT oi.*, m.name AS item_name, m.price AS unit_price
           FROM order_items oi
           JOIN menu_items1 m ON oi.menu_item_id = m.id
           WHERE oi.order_id = ?`,
          [order.id],
        )
        return { ...order, items }
      }),
    )
    res.json({ success: true, data: { orders: ordersWithItems } })
  } catch (err) {
    handleError(res, err, "fetching restaurant orders")
  }
})

app.put("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body || {}
  const allowed = new Set(["pending", "preparing", "ready", "on_the_way", "delivered", "cancelled", "rejected"])

  if (!status || !allowed.has(status)) {
    return res.status(400).json({
      success: false,
      error: "Invalid or missing status",
    })
  }

  let connection
  try {
    connection = await db.getConnection()
    await connection.beginTransaction()

    const [existing] = await connection.query("SELECT * FROM orders WHERE id = ?", [req.params.id])
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      })
    }

    const currentOrder = existing[0]

    // Prevent invalid status transitions
    if (currentOrder.status === "pending") {
      if (status !== "preparing" && status !== "rejected" && status !== "cancelled") {
        return res.status(400).json({
          success: false,
          error: "Pending orders can only move to preparing, rejected, or cancelled. Use /accept or /reject endpoints.",
        })
      }
    }

    // Only allow direct status updates for non-pending orders
    if (currentOrder.status === "pending" && (status === "preparing" || status === "rejected")) {
      return res.status(400).json({
        success: false,
        error: "Use /accept or /reject endpoints for pending orders",
      })
    }

    const [result] = await connection.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id])

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      })
    }

    const [updatedRows] = await connection.query("SELECT * FROM orders WHERE id = ?", [req.params.id])
    const updatedOrder = updatedRows[0]

    // Emit socket events
    io.to(`restaurant_${updatedOrder.restaurant_uid}`).emit("orderStatusUpdated", updatedOrder)
    io.to(`customer_${updatedOrder.customer_uid}`).emit("orderStatusUpdated", updatedOrder)

    // Send FCM notification for delivered status if orderNotifications is enabled
    if (status === "delivered") {
      const [prefs] = await connection.query(
        "SELECT order_notifications FROM restaurant_preferences WHERE restaurant_uid = ?",
        [updatedOrder.restaurant_uid],
      )
      const orderNotifications = prefs.length > 0 ? prefs[0].order_notifications : 1
      if (orderNotifications) {
        await sendFCMNotification(
          updatedOrder.restaurant_uid,
          `Order #${updatedOrder.id} Delivered`,
          "The order has been delivered.",
          {
            type: "orderStatusUpdated",
            orderId: updatedOrder.id.toString(),
            status: "delivered",
          },
        )
      }
    }

    await connection.commit()

    res.json({
      success: true,
      message: "Status updated",
      data: { order: updatedOrder },
    })
  } catch (err) {
    if (connection) await connection.rollback()
    handleError(res, err, "updating order status")
  } finally {
    if (connection) connection.release()
  }
})

// 1. Update document submission status (called after Google Form completion)
app.post("/api/restaurants/:uid/documents-submitted", async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim()

    // Verify restaurant exists
    const [restaurant] = await db.query("SELECT uid FROM restaurant_owners WHERE uid = ?", [trimmedUid])

    if (restaurant.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    // Update documents_submitted status and submission_date
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET documents_submitted = 1, submission_date = NOW()
       WHERE uid = ?`,
      [trimmedUid],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Failed to update document submission status",
      })
    }

    res.json({
      success: true,
      message: "Documents submission recorded successfully",
    })
  } catch (err) {
    handleError(res, err, "updating document submission status")
  }
})

// 2. Get restaurant verification status (for login check)
app.get("/api/restaurants/:uid/verification-status", async (req, res) => {
  try {
    const trimmedUid = req.params.uid.trim()

    const [rows] = await db.query(
      `SELECT verification_status, documents_submitted, verification_notes, 
          verification_date, submission_date 
   FROM restaurant_owners WHERE uid = ?`,
      [trimmedUid],
    )
    console.log("📊 Query result:", rows)

    if (rows.length === 0) {
      console.log("❌ No restaurant found for UID:", trimmedUid)
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    const status = rows[0]
    res.json({
      success: true,
      data: {
        verification_status: status.verification_status,
        documents_submitted: status.documents_submitted === 1,
        verification_notes: status.verification_notes,
        verification_date: status.verification_date,
        submission_date: status.submission_date,
        can_access_dashboard: status.verification_status === "verified",
      },
    })
  } catch (err) {
    console.error("💥 Verification status error:", err)
    handleError(res, err, "fetching verification status")
  }
})
// New endpoint to save device token
app.post("/api/restaurants/:uid/device-token", async (req, res) => {
  const { token } = req.body
  const { uid } = req.params

  if (!token || !uid) {
    return res.status(400).json({
      success: false,
      error: "Token and UID are required",
    })
  }

  try {
    const trimmedUid = uid.trim()
    await validateRestaurantUid(trimmedUid)

    // Upsert device token in device_tokens table
    await db.query(
      `INSERT INTO device_tokens (restaurant_uid, token, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE token = ?, updated_at = NOW()`,
      [trimmedUid, token, token],
    )

    res.json({
      success: true,
      message: "Device token saved successfully",
    })
  } catch (err) {
    handleError(res, err, "saving device token")
  }
})

// 3. Admin endpoint - Get all restaurants pending verification
app.get("/api/admin/restaurants/pending-verification", async (req, res) => {
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
    `)

    res.json({
      success: true,
      data: { restaurants },
    })
  } catch (err) {
    handleError(res, err, "fetching pending verifications")
  }
})

// 4. Admin endpoint - Update verification status
app.put("/api/admin/restaurants/:uid/verification", async (req, res) => {
  const { verification_status, verification_notes } = req.body

  // Validate input
  const allowedStatuses = ["verified", "rejected"]
  if (!verification_status || !allowedStatuses.includes(verification_status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid verification status. Must be "verified" or "rejected"',
    })
  }

  try {
    const trimmedUid = req.params.uid.trim()

    // Verify restaurant exists
    const [restaurant] = await db.query("SELECT uid, documents_submitted FROM restaurant_owners WHERE uid = ?", [
      trimmedUid,
    ])

    if (restaurant.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Restaurant not found for UID: ${trimmedUid}`,
      })
    }

    if (restaurant[0].documents_submitted !== 1) {
      return res.status(400).json({
        success: false,
        error: "Cannot verify restaurant without submitted documents",
      })
    }

    // Update verification status
    const [result] = await db.query(
      `UPDATE restaurant_owners 
       SET verification_status = ?, 
           verification_date = NOW(), 
           verification_notes = ?
       WHERE uid = ?`,
      [verification_status, verification_notes || null, trimmedUid],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "Failed to update verification status",
      })
    }

    // Get updated restaurant data
    const [updated] = await db.query("SELECT * FROM restaurant_owners WHERE uid = ?", [trimmedUid])

    // Emit notification to restaurant if verified/rejected
    io.to(`restaurant_${trimmedUid}`).emit("verificationStatusUpdated", {
      status: verification_status,
      notes: verification_notes,
      date: new Date().toISOString(),
    })

    res.json({
      success: true,
      message: `Restaurant ${verification_status} successfully`,
      data: { restaurant: updated[0] },
    })
  } catch (err) {
    handleError(res, err, "updating verification status")
  }
})

// 5. Get all restaurants with verification status (admin overview)
app.get("/api/admin/restaurants/all-with-status", async (req, res) => {
  try {
    const { status } = req.query // Optional filter by verification_status

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
    `

    const params = []

    if (status && ["pending", "verified", "rejected"].includes(status)) {
      query += " WHERE verification_status = ?"
      params.push(status)
    }

    query += " ORDER BY created_at DESC"

    const [restaurants] = await db.query(query, params)

    res.json({
      success: true,
      data: { restaurants },
    })
  } catch (err) {
    handleError(res, err, "fetching restaurants with verification status")
  }
})

// Get notification preferences for a restaurant
app.get("/api/restaurants/:uid/notification-preferences", async (req, res) => {
  const { uid } = req.params
  try {
    const trimmedUid = uid.trim()
    await validateRestaurantUid(trimmedUid)

    const [rows] = await db.query("SELECT order_notifications FROM restaurant_preferences WHERE restaurant_uid = ?", [
      trimmedUid,
    ])

    const orderNotifications = rows.length > 0 ? (rows[0].order_notifications ? 1 : 0) : 1

    return res.json({
      success: true,
      data: { order_notifications: orderNotifications },
    })
  } catch (err) {
    return handleError(res, err, "fetching notification preferences")
  }
})

// Update notification preferences for a restaurant
app.put("/api/restaurants/:uid/notification-preferences", async (req, res) => {
  const { uid } = req.params
  const { order_notifications } = req.body

  if (order_notifications !== 0 && order_notifications !== 1) {
    return res.status(400).json({
      success: false,
      error: "order_notifications must be 0 or 1",
    })
  }

  try {
    const trimmedUid = uid.trim()
    await validateRestaurantUid(trimmedUid)

    // upsert preference row
    await db.query(
      `INSERT INTO restaurant_preferences (restaurant_uid, order_notifications, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE order_notifications = VALUES(order_notifications), updated_at = NOW()`,
      [trimmedUid, order_notifications],
    )

    return res.json({
      success: true,
      data: { order_notifications },
      message: "Notification preferences updated",
    })
  } catch (err) {
    return handleError(res, err, "updating notification preferences")
  }
})

// Replace your existing sendFCMNotification function with this fixed version

// Replace your existing sendFCMNotification with this fixed version
async function sendFCMNotification(restaurantUid, title, body, data) {
  try {
    const [rows] = await db.query("SELECT token FROM device_tokens WHERE restaurant_uid = ?", [restaurantUid]);

    if (!rows || rows.length === 0) {
      console.log(`No device tokens found for restaurant ${restaurantUid}`);
      return;
    }

    // Extract tokens
    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
      console.log(`No valid tokens for restaurant ${restaurantUid}`);
      return;
    }

    // Ensure data values are strings (FCM requires string values)
    const normalizedData = {};
    if (data && typeof data === "object") {
      Object.keys(data).forEach((k) => {
        const v = data[k];
        normalizedData[k] = v === undefined || v === null ? "" : String(v);
      });
    }
    // Ensure some common keys exist
    normalizedData.orderId = normalizedData.orderId || (data?.orderId ? String(data.orderId) : "");
    normalizedData.type = normalizedData.type || (data?.type ? String(data.type) : "");
    normalizedData.status = normalizedData.status || (data?.status ? String(data.status) : "");

    // For a single token, use send(), for multiple tokens use sendMulticast()
    if (tokens.length === 1) {
      const message = {
        token: tokens[0],
        notification: { title, body },
        data: normalizedData,
        android: {
          priority: "high",
          notification: {
            channelId: "high_importance_channel",
            sound: "default",
          },
        },
        apns: { payload: { aps: { sound: "default" } } },
      };

      const response = await admin.messaging().send(message);
      console.log(`FCM notification sent to ${restaurantUid}. Message ID: ${response}`);
      return;
    }

    // Multiple tokens — build a multicast message
    const multicast = {
      tokens,
      notification: { title, body },
      data: normalizedData,
      android: {
        priority: "high",
        notification: {
          channelId: "high_importance_channel",
          sound: "default",
        },
      },
      apns: { payload: { aps: { sound: "default" } } },
    };

    const response = await admin.messaging().sendMulticast(multicast);
    console.log(
      `FCM multicast sent to restaurant ${restaurantUid}: success=${response.successCount}, failure=${response.failureCount}`
    );

    if (response.failureCount && response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((r, i) => {
        if (!r.success) {
          console.error(`Failed token[${i}]:`, r.error?.code || r.error?.message || r.error);
          if (r.error?.code === "messaging/registration-token-not-registered") {
            failedTokens.push(tokens[i]);
          }
        }
      });
      if (failedTokens.length > 0) {
        await db.query("DELETE FROM device_tokens WHERE token IN (?)", [failedTokens]);
        console.log(`Cleaned up ${failedTokens.length} invalid tokens for ${restaurantUid}`);
      }
    }
  } catch (err) {
    console.error(`Failed to send FCM notification to ${restaurantUid}:`, err);
  }
}

app.use((err, req, res, next) => {
  console.error("Server error:", err)
  res.status(500).json({
    success: false,
    error: "Internal server error",
    details: err?.message || "Unknown error",
  })
})

const PORT = process.env.PORT || 5001
server.listen(PORT, "0.0.0.0", () => {
  console.log(` API server running at http://0.0.0.0:${PORT}`)
  console.log(" Endpoints: /api/restaurants, /api/menu, /api/categories, /api/customers, /api/orders, /health")
  console.log(" Socket.IO events: joinRestaurant, joinCustomer, newOrder, orderPlaced, orderStatusUpdated")
})
