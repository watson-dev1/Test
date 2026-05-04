/**
 * Database Connection Handler
 * Copyright © 2025 DarkSide Developers
 */

const { Sequelize } = require('sequelize');
const config = require('../config');
const chalk = require('chalk');

const DATABASE_URL = config.DATABASE_URL;

// Advanced Database Connection with Error Handling
const database = DATABASE_URL === "local" ?
    new Sequelize({ 
        dialect: 'sqlite', 
        storage: "./database/store/queen-mini.db", 
        logging: false,
        pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }) :
    new Sequelize(DATABASE_URL, {
        dialect: 'postgres',
        ssl: true,
        protocol: 'postgres',
        dialectOptions: { 
            native: true, 
            ssl: { 
                require: true, 
                rejectUnauthorized: false 
            } 
        },
        logging: false,
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    });

// Connection Test with Advanced Error Handling
const connectDatabase = async () => {
    try {
        await database.authenticate();
        console.log(chalk.green('✅ Database connection established successfully.'));
        
        // Sync all models
        await database.sync({ alter: true });
        console.log(chalk.blue('📊 Database models synchronized.'));
        
        return true;
    } catch (error) {
        console.error(chalk.red('❌ Unable to connect to the database:'), error.message);
        
        // Advanced error handling
        if (error.name === 'SequelizeConnectionError') {
            console.error(chalk.yellow('🔄 Retrying database connection in 5 seconds...'));
            setTimeout(connectDatabase, 5000);
        } else if (error.name === 'SequelizeAccessDeniedError') {
            console.error(chalk.red('🚫 Database access denied. Check credentials.'));
        } else {
            console.error(chalk.red('💥 Unexpected database error:'), error);
        }
        
        return false;
    }
};

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n🔄 Gracefully shutting down database connection...'));
    await database.close();
    console.log(chalk.green('✅ Database connection closed.'));
    process.exit(0);
});

module.exports = { database, connectDatabase };
