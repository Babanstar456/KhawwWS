import dotenv from 'dotenv';
dotenv.config({ path: './.env' });
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'in-mum-web673.main-hosting.eu',
  user: process.env.DB_USER || 'u617065149_restaurant_adm',
  password: process.env.DB_PASSWORD || 'SwattikA1',
  database: process.env.DB_NAME || 'u617065149_restaurant_db',
  port: process.env.DB_PORT || 3306,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000
});

async function testConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.ping();
    console.log('MySQL connected');
  } finally {
    if (conn) conn.release();
  }
}

async function initializeDatabase() {
  let connection;
  try {
    connection = await pool.getConnection();

    // RESTAURANT OWNER TABLE
    await connection.query(`
      CREATE TABLE IF NOT EXISTS restaurant_owners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uid VARCHAR(255) NOT NULL UNIQUE COMMENT 'Firebase Auth UID',
        restaurant_name VARCHAR(255) NOT NULL,
        location VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        is_pure_veg TINYINT(1) DEFAULT 1 COMMENT '1 for Pure Veg, 0 for Non-Veg',
        is_online TINYINT(1) DEFAULT 1 COMMENT '1 for Online, 0 for Offline',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_uid (uid),
        INDEX idx_email (email)
      )
    `);

    // Add is_pure_veg column if not exists
    try {
      await connection.query(`
        ALTER TABLE restaurant_owners
        ADD COLUMN is_pure_veg TINYINT(1) DEFAULT 1 COMMENT '1 for Pure Veg, 0 for Non-Veg'
      `);
      console.log('Added is_pure_veg column to restaurant_owners');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('is_pure_veg column already exists in restaurant_owners');
      } else {
        console.error('Failed to add is_pure_veg column:', err);
      }
    }

    // CATEGORIES TABLE
    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories1 (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        restaurant_uid VARCHAR(255) NOT NULL,
        UNIQUE KEY unique_category_per_restaurant (name, restaurant_uid),
        FOREIGN KEY (restaurant_uid) REFERENCES restaurant_owners(uid)
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    // MENU ITEMS TABLE
    await connection.query(`
      CREATE TABLE IF NOT EXISTS menu_items1 (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        category VARCHAR(255) NOT NULL,
        restaurant_uid VARCHAR(255) NOT NULL,
        is_available TINYINT(1) DEFAULT 1,
        is_deleted TINYINT(1) DEFAULT 0,
        image_url VARCHAR(512),
        food_type TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0 for Veg, 1 for Non-Veg',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category, restaurant_uid) REFERENCES categories1(name, restaurant_uid)
          ON DELETE RESTRICT ON UPDATE CASCADE,
        FOREIGN KEY (restaurant_uid) REFERENCES restaurant_owners(uid)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT chk_food_type CHECK (food_type IN (0,1))
      )
    `);

    // Migrate food_type if needed
    try {
      await connection.query(`
        ALTER TABLE menu_items1
        MODIFY COLUMN food_type TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0 for Veg, 1 for Non-Veg'
      `);
      await connection.query(`
        UPDATE menu_items1
        SET food_type = CASE
          WHEN food_type = 'Veg' THEN 0
          WHEN food_type = 'Non-Veg' THEN 1
          ELSE food_type
        END
      `);
      console.log('Migrated food_type to TINYINT in menu_items1');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') {
        console.error('Failed to migrate food_type:', err);
      }
    }

    // Ensure is_deleted column
    try {
      await connection.query(`
        ALTER TABLE menu_items1
        ADD COLUMN is_deleted TINYINT(1) DEFAULT 0
      `);
      console.log('Added is_deleted column to menu_items1');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('is_deleted column already exists in menu_items1');
      } else {
        console.error('Failed to add is_deleted column:', err);
      }
    }

    // CUSTOMERS TABLE
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uid VARCHAR(255) NOT NULL UNIQUE COMMENT 'Firebase Auth UID for customer',
        name VARCHAR(255),
        phone VARCHAR(20),
        email VARCHAR(255),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cust_uid (uid)
      )
    `);

    // ORDERS TABLE (with customer_name and phone_number)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        restaurant_uid VARCHAR(255) NOT NULL,
        customer_uid VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        status ENUM('pending','preparing','ready','on_the_way','delivered','cancelled') DEFAULT 'pending' NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        delivery_address TEXT NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (restaurant_uid) REFERENCES restaurant_owners(uid)
          ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (customer_uid) REFERENCES customers(uid)
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    // Add customer_name and phone_number if not exists
    try {
      await connection.query(`
        ALTER TABLE orders
        ADD COLUMN customer_name VARCHAR(255) NOT NULL
      `);
      console.log('Added customer_name column to orders');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('customer_name column already exists in orders');
      } else {
        console.error('Failed to add customer_name column:', err);
      }
    }

    try {
      await connection.query(`
        ALTER TABLE orders
        ADD COLUMN phone_number VARCHAR(20) NOT NULL
      `);
      console.log('Added phone_number column to orders');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('phone_number column already exists in orders');
      } else {
        console.error('Failed to add phone_number column:', err);
      }
    }
    // Add payment-related columns if not exists
try {
  await connection.query(`
    ALTER TABLE orders
    ADD COLUMN payment_id VARCHAR(255) DEFAULT NULL COMMENT 'Cashfree Payment ID',
    ADD COLUMN payment_status ENUM('pending', 'success', 'failed', 'cancelled') DEFAULT 'pending' NOT NULL,
    ADD COLUMN payment_session_id VARCHAR(255) DEFAULT NULL COMMENT 'Cashfree Session ID for frontend'
  `);
  console.log('Added payment columns to orders');
} catch (err) {
  if (err.code === 'ER_DUP_FIELDNAME') {
    console.log('Payment columns already exist in orders');
  } else {
    console.error('Failed to add payment columns:', err);
  }
}

    // ORDER ITEMS TABLE
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        menu_item_id INT NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (menu_item_id) REFERENCES menu_items1(id)
          ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `);

    // Ensure CHECK constraint for food_type
    try {
      await connection.query(`
        ALTER TABLE menu_items1 DROP CHECK chk_food_type
      `);
      console.log('Dropped legacy chk_food_type constraint');
    } catch (err) {
      // Ignore if not exists
    }
    try {
      await connection.query(`
        ALTER TABLE menu_items1
        ADD CONSTRAINT chk_food_type CHECK (food_type IN (0,1))
      `);
      console.log('Added chk_food_type constraint');
    } catch (err) {
      console.log('CHECK constraint already exists or not supported:', err.code || err);
    }

    // Ensure order_items FK to menu_items1 is RESTRICT
    try {
      const [fkRows] = await connection.query(`
        SELECT CONSTRAINT_NAME
        FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'order_items'
          AND REFERENCED_TABLE_NAME = 'menu_items1'
      `);
      for (const row of fkRows) {
        try {
          await connection.query('ALTER TABLE order_items DROP FOREIGN KEY ??', [row.CONSTRAINT_NAME]);
          console.log('Dropped FK', row.CONSTRAINT_NAME, 'on order_items');
        } catch (e) {
          console.log('Could not drop FK', row.CONSTRAINT_NAME, e.code || e);
        }
      }
      await connection.query(`
        ALTER TABLE order_items
        ADD CONSTRAINT fk_order_items_menu_item_id
        FOREIGN KEY (menu_item_id) REFERENCES menu_items1(id)
        ON DELETE RESTRICT ON UPDATE CASCADE
      `);
      console.log('Ensured RESTRICT FK fk_order_items_menu_item_id on order_items(menu_item_id)');
    } catch (err) {
      console.log('FK migration (order_items -> menu_items1) skipped or failed:', err.code || err);
    }

    console.log('âœ… All database tables verified/created:');
    console.log('  - restaurant_owners');
    console.log('  - categories1');
    console.log('  - menu_items1');
    console.log('  - customers');
    console.log('  - orders');
    console.log('  - order_items');
  } catch (err) {
    console.error('DB init failed:', err);
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

// Test connection and initialize tables
(async () => {
  try {
    await testConnection();
    await initializeDatabase();
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();

export default pool;