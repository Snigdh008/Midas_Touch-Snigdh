const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game State
const gameState = {
  teams: {},
  stocks: {
    'TATAMOTORS': { name: 'TATA MOTORS', price: 400, symbol: 'TATAMOTORS' },
    'ADANIGREEN': { name: 'ADANI GREEN', price: 1025, symbol: 'ADANIGREEN' },
    'ONGC': { name: 'ONGC', price: 255, symbol: 'ONGC' },
    'RELIANCE': { name: 'RELIANCE', price: 1450, symbol: 'RELIANCE' },
    'ITC': { name: 'ITC', price: 415, symbol: 'ITC' },
    'HDFCBANK': { name: 'HDFC BANK', price: 1000, symbol: 'HDFCBANK' },
    'ICICIBANK': { name: 'ICICI BANK', price: 1375, symbol: 'ICICIBANK' },
    'ZOMATO': { name: 'ZOMATO', price: 325, symbol: 'ZOMATO' },
    'TATAELXSI': { name: 'TATA ELXSI', price: 5540, symbol: 'TATAELXSI' },
    'INFOSYS': { name: 'INFOSYS', price: 1520, symbol: 'INFOSYS' },
    'LNT': { name: 'L&T', price: 3900, symbol: 'LNT' },
    'GOLD': { name: 'GOLD', price: 122500, symbol: 'GOLD' },
    'SILVER': { name: 'SILVER', price: 150000, symbol: 'SILVER' },
    'CRUDEOIL': { name: 'CRUDE OIL', price: 5425, symbol: 'CRUDEOIL' },
    'DOGE': { name: 'DOGE COIN', price: 17, symbol: 'DOGE' },
    'ETHEREUM': { name: 'ETHEREUM', price: 345000, symbol: 'ETHEREUM' }
  },
  trades: [],
  news: [],
  marketTips: [],
  messages: [],
  gameConfig: {
    phase: 'waiting',
    startingBalance: 100000,
    adminPassword: 'admin123',
    currentRound: 0,
    totalRounds: 0,
    timeRemaining: 0,
    portfolioAllocationTime: 600
  }
};

let timerInterval = null;

// Helper Functions
function generateJoinCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calculatePortfolioValue(team) {
  let value = team.cash;
  
  // Add long holdings value
  Object.entries(team.holdings || {}).forEach(([symbol, qty]) => {
    const stock = gameState.stocks[symbol];
    if (stock) value += qty * stock.price;
  });
  
  // Subtract short holdings value
  Object.entries(team.shortHoldings || {}).forEach(([symbol, qty]) => {
    const stock = gameState.stocks[symbol];
    if (stock) value -= qty * stock.price;
  });
  
  return value;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(() => {
    if (gameState.gameConfig.timeRemaining > 0) {
      gameState.gameConfig.timeRemaining--;
      io.emit('timer_update', gameState.gameConfig);
      
      if (gameState.gameConfig.timeRemaining === 0) {
        handleTimerEnd();
      }
    }
  }, 1000);
}

function handleTimerEnd() {
  if (gameState.gameConfig.phase === 'portfolio_allocation') {
    gameState.gameConfig.phase = 'waiting';
    io.emit('phase_change', gameState.gameConfig);
    io.emit('notification', { message: 'Portfolio Allocation phase ended', type: 'info' });
  } else if (gameState.gameConfig.phase === 'trading') {
    if (gameState.gameConfig.currentRound < gameState.gameConfig.totalRounds) {
      gameState.gameConfig.currentRound++;
      gameState.gameConfig.timeRemaining = gameState.gameConfig.portfolioAllocationTime;
      io.emit('phase_change', gameState.gameConfig);
      io.emit('notification', { message: `Trading Round ${gameState.gameConfig.currentRound} started`, type: 'info' });
    } else {
      gameState.gameConfig.phase = 'ended';
      io.emit('phase_change', gameState.gameConfig);
      io.emit('notification', { message: 'Game ended', type: 'success' });
      if (timerInterval) clearInterval(timerInterval);
    }
  }
}

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Send initial game state
  socket.emit('game_state', {
    teams: Object.values(gameState.teams),
    stocks: Object.values(gameState.stocks),
    trades: gameState.trades,
    news: gameState.news,
    marketTips: gameState.marketTips,
    gameConfig: gameState.gameConfig
  });

  // Admin Login
  socket.on('admin_login', (password, callback) => {
    if (password === gameState.gameConfig.adminPassword) {
      callback({ success: true });
      socket.emit('all_messages', gameState.messages);
    } else {
      callback({ success: false, error: 'Invalid password' });
    }
  });

  // Create Team
  socket.on('create_team', (data, callback) => {
    const teamId = uuidv4();
    const joinCode = generateJoinCode();
    
    const newTeam = {
      id: teamId,
      name: data.name,
      cash: data.startingBalance,
      startingBalance: data.startingBalance,
      holdings: {},
      shortHoldings: {},
      joinCode: joinCode,
      trades: []
    };
    
    gameState.teams[teamId] = newTeam;
    
    io.emit('team_created', newTeam);
    callback({ success: true, team: newTeam });
  });

  // Team Join
  socket.on('team_join', (joinCode, callback) => {
    const team = Object.values(gameState.teams).find(t => t.joinCode === joinCode.toUpperCase());
    
    if (team) {
      socket.join(`team_${team.id}`);
      callback({ success: true, team: team });
      
      // Send team-specific messages
      const teamMessages = gameState.messages.filter(
        msg => msg.fromTeamId === team.id || msg.toTeamId === team.id
      );
      socket.emit('team_messages', teamMessages);
    } else {
      callback({ success: false, error: 'Invalid join code' });
    }
  });

  // Update Stock Price
  socket.on('update_stock_price', (data) => {
    const { symbol, price } = data;
    if (gameState.stocks[symbol]) {
      gameState.stocks[symbol].price = price;
      io.emit('stock_price_update', { symbol, price });
      io.emit('stocks_update', Object.values(gameState.stocks));
    }
  });

  // Broadcast News
  socket.on('broadcast_news', (data) => {
    const newsItem = {
      id: uuidv4(),
      title: data.title,
      content: data.content,
      timestamp: new Date().toLocaleString()
    };
    
    gameState.news.unshift(newsItem);
    io.emit('news_broadcast', newsItem);
  });

  // Post Market Tip
  socket.on('post_market_tip', (data) => {
    const tip = {
      id: uuidv4(),
      content: data.content,
      timestamp: new Date().toLocaleString()
    };
    
    gameState.marketTips.unshift(tip);
    io.emit('market_tip_posted', tip);
  });

  // Start Phase
  socket.on('start_phase', (data) => {
    const { phase, duration, rounds } = data;
    
    gameState.gameConfig.phase = phase;
    gameState.gameConfig.timeRemaining = duration;
    
    if (phase === 'trading') {
      gameState.gameConfig.currentRound = 1;
      gameState.gameConfig.totalRounds = rounds;
    } else {
      gameState.gameConfig.currentRound = 0;
      gameState.gameConfig.totalRounds = 0;
    }
    
    if (phase === 'portfolio_allocation' || phase === 'trading') {
      gameState.gameConfig.portfolioAllocationTime = duration;
    }
    
    startTimer();
    io.emit('phase_change', gameState.gameConfig);
  });

  // Execute Trade
  socket.on('execute_trade', (data, callback) => {
    const { teamId, action, symbol, quantity, price } = data;
    const team = gameState.teams[teamId];
    const stock = gameState.stocks[symbol];
    
    if (!team || !stock) {
      return callback({ success: false, error: 'Invalid team or stock' });
    }
    
    const totalCost = quantity * price;
    
    // Validate based on action
    if (action === 'buy') {
      if (team.cash < totalCost) {
        return callback({ success: false, error: 'Insufficient funds' });
      }
      team.cash -= totalCost;
      team.holdings[symbol] = (team.holdings[symbol] || 0) + quantity;
      
    } else if (action === 'sell') {
      if ((team.holdings[symbol] || 0) < quantity) {
        return callback({ success: false, error: 'Insufficient holdings' });
      }
      team.cash += totalCost;
      team.holdings[symbol] -= quantity;
      if (team.holdings[symbol] === 0) delete team.holdings[symbol];
      
    } else if (action === 'short_sell') {
      // Only allowed in trading phase
      if (gameState.gameConfig.phase !== 'trading') {
        return callback({ success: false, error: 'Short selling only allowed in trading phase' });
      }
      // Cannot short more than 100% of remaining cash
      if (totalCost > team.cash) {
        return callback({ success: false, error: 'Cannot short more than 100% of remaining cash' });
      }
      team.cash += totalCost;
      team.shortHoldings[symbol] = (team.shortHoldings[symbol] || 0) + quantity;
      
    } else if (action === 'cover_short') {
      if ((team.shortHoldings[symbol] || 0) < quantity) {
        return callback({ success: false, error: 'Insufficient short positions' });
      }
      if (team.cash < totalCost) {
        return callback({ success: false, error: 'Insufficient funds to cover short' });
      }
      team.cash -= totalCost;
      team.shortHoldings[symbol] -= quantity;
      if (team.shortHoldings[symbol] === 0) delete team.shortHoldings[symbol];
    }
    
    // Record trade
    const trade = {
      id: uuidv4(),
      teamId,
      teamName: team.name,
      action,
      symbol,
      quantity,
      price,
      timestamp: new Date().toLocaleString()
    };
    
    team.trades.push(trade);
    gameState.trades.unshift(trade);
    
    // Broadcast updates
    io.emit('trade_executed', trade);
    io.emit('team_updated', team);
    
    // Calculate and emit leaderboard update
    const leaderboard = Object.values(gameState.teams).map(t => ({
      id: t.id,
      name: t.name,
      portfolioValue: calculatePortfolioValue(t)
    })).sort((a, b) => b.portfolioValue - a.portfolioValue);
    
    io.emit('leaderboard_update', leaderboard);
    
    callback({ success: true, team: team });
  });

  // Send Message
  socket.on('send_message', (data) => {
    const message = {
      id: uuidv4(),
      fromTeamId: data.fromTeamId,
      fromTeamName: gameState.teams[data.fromTeamId]?.name || 'Unknown',
      toTeamId: data.toTeamId,
      toTeamName: gameState.teams[data.toTeamId]?.name || 'Unknown',
      message: data.message,
      timestamp: new Date().toLocaleString()
    };
    
    gameState.messages.unshift(message);
    
    // Emit to both teams involved
    io.to(`team_${data.fromTeamId}`).emit('new_message', message);
    io.to(`team_${data.toTeamId}`).emit('new_message', message);
    
    // Emit to all admin connections
    io.emit('admin_message', message);
  });

  // Get Team Messages
  socket.on('get_team_messages', (teamId) => {
    const teamMessages = gameState.messages.filter(
      msg => msg.fromTeamId === teamId || msg.toTeamId === teamId
    );
    socket.emit('team_messages', teamMessages);
  });

  // Reset Platform
  socket.on('reset_platform', () => {
    // Clear timer
    if (timerInterval) clearInterval(timerInterval);
    
    // Reset game state
    gameState.teams = {};
    gameState.trades = [];
    gameState.news = [];
    gameState.marketTips = [];
    gameState.messages = [];
    gameState.gameConfig = {
      phase: 'waiting',
      startingBalance: 100000,
      adminPassword: 'admin123',
      currentRound: 0,
      totalRounds: 0,
      timeRemaining: 0,
      portfolioAllocationTime: 600
    };
    
    // Reset stock prices to initial values
    gameState.stocks = {
      'TATAMOTORS': { name: 'TATA MOTORS', price: 400, symbol: 'TATAMOTORS' },
      'ADANIGREEN': { name: 'ADANI GREEN', price: 1025, symbol: 'ADANIGREEN' },
      'ONGC': { name: 'ONGC', price: 255, symbol: 'ONGC' },
      'RELIANCE': { name: 'RELIANCE', price: 1450, symbol: 'RELIANCE' },
      'ITC': { name: 'ITC', price: 415, symbol: 'ITC' },
      'HDFCBANK': { name: 'HDFC BANK', price: 1000, symbol: 'HDFCBANK' },
      'ICICIBANK': { name: 'ICICI BANK', price: 1375, symbol: 'ICICIBANK' },
      'ZOMATO': { name: 'ZOMATO', price: 325, symbol: 'ZOMATO' },
      'TATAELXSI': { name: 'TATA ELXSI', price: 5540, symbol: 'TATAELXSI' },
      'INFOSYS': { name: 'INFOSYS', price: 1520, symbol: 'INFOSYS' },
      'LNT': { name: 'L&T', price: 3900, symbol: 'LNT' },
      'GOLD': { name: 'GOLD', price: 122500, symbol: 'GOLD' },
      'SILVER': { name: 'SILVER', price: 150000, symbol: 'SILVER' },
      'CRUDEOIL': { name: 'CRUDE OIL', price: 5425, symbol: 'CRUDEOIL' },
      'DOGE': { name: 'DOGE COIN', price: 17, symbol: 'DOGE' },
      'ETHEREUM': { name: 'ETHEREUM', price: 345000, symbol: 'ETHEREUM' }
    };
    
    io.emit('platform_reset');
  });

  // Download Tradebook
  socket.on('download_tradebook', (teamId, callback) => {
    let trades;
    if (teamId) {
      const team = gameState.teams[teamId];
      trades = team ? team.trades : [];
    } else {
      trades = gameState.trades;
    }
    
    // Generate CSV
    let csv = 'Timestamp,Team,Action,Symbol,Quantity,Price,Total\n';
    trades.forEach(trade => {
      const total = trade.quantity * trade.price;
      csv += `${trade.timestamp},${trade.teamName},${trade.action},${trade.symbol},${trade.quantity},${trade.price},${total}\n`;
    });
    
    callback({ success: true, csv: csv });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve trading.html (UPDATED FILE NAME)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'trading.html'));
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Mock Stock Trading Platform running on http://localhost:${PORT}`);
  console.log(`📊 Admin password: ${gameState.gameConfig.adminPassword}`);
});