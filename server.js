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
  tradeRequests: {},
  gameConfig: {
    phase: 'waiting',
    startingBalance: 100000,
    adminPassword: 'admin123',
    currentRound: 0,
    totalRounds: 0,
    timeRemaining: 0,
    portfolioAllocationTime: 600,
    tradingRoundTime: 600,
    circuitLimitFrozen: false,
    marketTradingEnabled: false,
    shortSellingFrozen: false
  }
};

let timerInterval = null;
let requestTimers = {};

// Helper Functions
function generateJoinCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calculatePortfolioValue(team) {
  let value = team.cash;
  
  Object.entries(team.holdings || {}).forEach(([symbol, qty]) => {
    const stock = gameState.stocks[symbol];
    if (stock) value += qty * stock.price;
  });
  
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
      gameState.gameConfig.timeRemaining = gameState.gameConfig.tradingRoundTime;
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

function checkCircuitLimit(symbol, proposedPrice) {
  if (gameState.gameConfig.circuitLimitFrozen) {
    return { valid: true, message: 'Circuit limit frozen' };
  }
  
  const currentPrice = gameState.stocks[symbol].price;
  const lowerLimit = currentPrice * 0.92;
  const upperLimit = currentPrice * 1.08;
  
  if (proposedPrice < lowerLimit || proposedPrice > upperLimit) {
    return { 
      valid: false, 
      message: `Price not obeying circuit limit (₹${lowerLimit.toFixed(2)} - ₹${upperLimit.toFixed(2)})` 
    };
  }
  
  return { valid: true, message: 'Price within circuit limit' };
}

function closeShortPositions(teamId) {
  const team = gameState.teams[teamId];
  if (!team || !team.shortHoldings) return;
  
  Object.entries(team.shortHoldings).forEach(([symbol, qty]) => {
    const stock = gameState.stocks[symbol];
    if (stock && qty > 0) {
      const totalCost = qty * stock.price;
      team.cash -= totalCost;
      
      const trade = {
        id: uuidv4(),
        teamId,
        teamName: team.name,
        action: 'cover_short_forced',
        symbol,
        quantity: qty,
        price: stock.price,
        timestamp: new Date().toLocaleString(),
        note: 'Forced exit due to short selling freeze'
      };
      
      team.trades.push(trade);
      gameState.trades.unshift(trade);
    }
  });
  
  team.shortHoldings = {};
  io.emit('team_updated', team);
}

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.emit('game_state', {
    teams: Object.values(gameState.teams),
    stocks: Object.values(gameState.stocks),
    trades: gameState.trades,
    news: gameState.news,
    marketTips: gameState.marketTips,
    gameConfig: gameState.gameConfig
  });

  socket.on('admin_login', (password, callback) => {
    if (password === gameState.gameConfig.adminPassword) {
      callback({ success: true });
      socket.emit('all_messages', gameState.messages);
    } else {
      callback({ success: false, error: 'Invalid password' });
    }
  });

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

  socket.on('team_join', (joinCode, callback) => {
    const team = Object.values(gameState.teams).find(t => t.joinCode === joinCode.toUpperCase());
    
    if (team) {
      socket.join(`team_${team.id}`);
      callback({ success: true, team: team });
      
      const teamMessages = gameState.messages.filter(
        msg => msg.fromTeamId === team.id || msg.toTeamId === team.id
      );
      socket.emit('team_messages', teamMessages);
    } else {
      callback({ success: false, error: 'Invalid join code' });
    }
  });

  socket.on('update_stock_price', (data) => {
    const { symbol, price } = data;
    if (gameState.stocks[symbol]) {
      gameState.stocks[symbol].price = price;
      io.emit('stock_price_update', { symbol, price });
      io.emit('stocks_update', Object.values(gameState.stocks));
    }
  });

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

  socket.on('post_market_tip', (data) => {
    const tip = {
      id: uuidv4(),
      content: data.content,
      timestamp: new Date().toLocaleString()
    };
    
    gameState.marketTips.unshift(tip);
    io.emit('market_tip_posted', tip);
  });

  socket.on('start_phase', (data) => {
    const { phase, duration, rounds, tradingRoundTime } = data;
    
    gameState.gameConfig.phase = phase;
    gameState.gameConfig.timeRemaining = duration;
    
    if (phase === 'trading') {
      gameState.gameConfig.currentRound = 1;
      gameState.gameConfig.totalRounds = rounds;
      gameState.gameConfig.tradingRoundTime = tradingRoundTime || duration;
    } else {
      gameState.gameConfig.currentRound = 0;
      gameState.gameConfig.totalRounds = 0;
    }
    
    if (phase === 'portfolio_allocation') {
      gameState.gameConfig.portfolioAllocationTime = duration;
    }
    
    startTimer();
    io.emit('phase_change', gameState.gameConfig);
  });

  socket.on('toggle_circuit_freeze', (callback) => {
    gameState.gameConfig.circuitLimitFrozen = !gameState.gameConfig.circuitLimitFrozen;
    io.emit('config_update', gameState.gameConfig);
    callback({ success: true, frozen: gameState.gameConfig.circuitLimitFrozen });
  });

  socket.on('toggle_market_trading', (callback) => {
    gameState.gameConfig.marketTradingEnabled = !gameState.gameConfig.marketTradingEnabled;
    io.emit('config_update', gameState.gameConfig);
    callback({ success: true, enabled: gameState.gameConfig.marketTradingEnabled });
  });

  socket.on('toggle_short_freeze', (callback) => {
    gameState.gameConfig.shortSellingFrozen = !gameState.gameConfig.shortSellingFrozen;
    
    if (gameState.gameConfig.shortSellingFrozen) {
      Object.keys(gameState.teams).forEach(teamId => {
        closeShortPositions(teamId);
      });
    }
    
    io.emit('config_update', gameState.gameConfig);
    callback({ success: true, frozen: gameState.gameConfig.shortSellingFrozen });
  });

  socket.on('allocate_funds', (data, callback) => {
    const { teamId, amount } = data;
    const team = gameState.teams[teamId];
    
    if (!team) {
      return callback({ success: false, error: 'Team not found' });
    }
    
    team.cash += amount;
    
    const trade = {
      id: uuidv4(),
      teamId,
      teamName: team.name,
      action: 'fund_allocation',
      symbol: 'CASH',
      quantity: 1,
      price: amount,
      timestamp: new Date().toLocaleString(),
      note: `Admin allocated ₹${amount.toLocaleString()}`
    };
    
    team.trades.push(trade);
    gameState.trades.unshift(trade);
    
    io.emit('team_updated', team);
    callback({ success: true, team });
  });

  socket.on('execute_trade', (data, callback) => {
    const { teamId, action, symbol, quantity, price } = data;
    const team = gameState.teams[teamId];
    const stock = gameState.stocks[symbol];
    
    if (!team || !stock) {
      return callback({ success: false, error: 'Invalid team or stock' });
    }
    
    const totalCost = quantity * price;
    
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
      if (gameState.gameConfig.shortSellingFrozen) {
        return callback({ success: false, error: 'Short selling is currently frozen' });
      }
      if (gameState.gameConfig.phase !== 'trading') {
        return callback({ success: false, error: 'Short selling only allowed in trading phase' });
      }
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
    
    io.emit('trade_executed', trade);
    io.emit('team_updated', team);
    
    callback({ success: true, team: team });
  });

  socket.on('send_trade_request', (data, callback) => {
    const { fromTeamId, toTeamId, action, symbol, quantity, price } = data;
    const fromTeam = gameState.teams[fromTeamId];
    const toTeam = gameState.teams[toTeamId];
    const stock = gameState.stocks[symbol];
    
    if (!fromTeam || !toTeam || !stock) {
      return callback({ success: false, error: 'Invalid request' });
    }
    
    const circuitCheck = checkCircuitLimit(symbol, price);
    if (!circuitCheck.valid) {
      return callback({ success: false, error: circuitCheck.message });
    }
    
    const requestId = uuidv4();
    const request = {
      id: requestId,
      fromTeamId,
      fromTeamName: fromTeam.name,
      toTeamId,
      toTeamName: toTeam.name,
      action,
      symbol,
      stockName: stock.name,
      quantity,
      price,
      timestamp: new Date().toLocaleString(),
      expiresAt: Date.now() + 20000
    };
    
    gameState.tradeRequests[requestId] = request;
    
    io.to(`team_${fromTeamId}`).emit('trade_request_sent', request);
    io.to(`team_${toTeamId}`).emit('trade_request_received', request);
    
    requestTimers[requestId] = setTimeout(() => {
      delete gameState.tradeRequests[requestId];
      io.to(`team_${fromTeamId}`).emit('trade_request_expired', requestId);
      io.to(`team_${toTeamId}`).emit('trade_request_expired', requestId);
    }, 20000);
    
    callback({ success: true, request });
  });

  socket.on('respond_trade_request', (data, callback) => {
    const { requestId, accept } = data;
    const request = gameState.tradeRequests[requestId];
    
    if (!request) {
      return callback({ success: false, error: 'Request not found or expired' });
    }
    
    if (requestTimers[requestId]) {
      clearTimeout(requestTimers[requestId]);
      delete requestTimers[requestId];
    }
    
    delete gameState.tradeRequests[requestId];
    
    if (!accept) {
      io.to(`team_${request.fromTeamId}`).emit('trade_request_cancelled', requestId);
      io.to(`team_${request.toTeamId}`).emit('trade_request_cancelled', requestId);
      return callback({ success: true, message: 'Request cancelled' });
    }
    
    const buyerTeam = request.action === 'buy' ? gameState.teams[request.fromTeamId] : gameState.teams[request.toTeamId];
    const sellerTeam = request.action === 'buy' ? gameState.teams[request.toTeamId] : gameState.teams[request.fromTeamId];
    
    const totalCost = request.quantity * request.price;
    
    if (buyerTeam.cash < totalCost) {
      io.to(`team_${request.fromTeamId}`).emit('trade_request_failed', { requestId, error: 'Insufficient funds' });
      io.to(`team_${request.toTeamId}`).emit('trade_request_failed', { requestId, error: 'Insufficient funds' });
      return callback({ success: false, error: 'Buyer has insufficient funds' });
    }
    
    if ((sellerTeam.holdings[request.symbol] || 0) < request.quantity) {
      io.to(`team_${request.fromTeamId}`).emit('trade_request_failed', { requestId, error: 'Insufficient holdings' });
      io.to(`team_${request.toTeamId}`).emit('trade_request_failed', { requestId, error: 'Insufficient holdings' });
      return callback({ success: false, error: 'Seller has insufficient holdings' });
    }
    
    buyerTeam.cash -= totalCost;
    sellerTeam.cash += totalCost;
    
    buyerTeam.holdings[request.symbol] = (buyerTeam.holdings[request.symbol] || 0) + request.quantity;
    sellerTeam.holdings[request.symbol] -= request.quantity;
    if (sellerTeam.holdings[request.symbol] === 0) delete sellerTeam.holdings[request.symbol];
    
    const buyTrade = {
      id: uuidv4(),
      teamId: buyerTeam.id,
      teamName: buyerTeam.name,
      action: 'buy',
      symbol: request.symbol,
      quantity: request.quantity,
      price: request.price,
      timestamp: new Date().toLocaleString(),
      counterparty: sellerTeam.name
    };
    
    const sellTrade = {
      id: uuidv4(),
      teamId: sellerTeam.id,
      teamName: sellerTeam.name,
      action: 'sell',
      symbol: request.symbol,
      quantity: request.quantity,
      price: request.price,
      timestamp: new Date().toLocaleString(),
      counterparty: buyerTeam.name
    };
    
    buyerTeam.trades.push(buyTrade);
    sellerTeam.trades.push(sellTrade);
    gameState.trades.unshift(buyTrade);
    gameState.trades.unshift(sellTrade);
    
    io.emit('trade_executed', buyTrade);
    io.emit('trade_executed', sellTrade);
    io.emit('team_updated', buyerTeam);
    io.emit('team_updated', sellerTeam);
    
    io.to(`team_${request.fromTeamId}`).emit('trade_request_completed', requestId);
    io.to(`team_${request.toTeamId}`).emit('trade_request_completed', requestId);
    
    callback({ success: true });
  });

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
    
    io.to(`team_${data.fromTeamId}`).emit('new_message', message);
    io.to(`team_${data.toTeamId}`).emit('new_message', message);
    io.emit('admin_message', message);
  });

  socket.on('get_team_messages', (teamId) => {
    const teamMessages = gameState.messages.filter(
      msg => msg.fromTeamId === teamId || msg.toTeamId === teamId
    );
    socket.emit('team_messages', teamMessages);
  });

  socket.on('reset_platform', () => {
    if (timerInterval) clearInterval(timerInterval);
    
    Object.values(requestTimers).forEach(timer => clearTimeout(timer));
    requestTimers = {};
    
    gameState.teams = {};
    gameState.trades = [];
    gameState.news = [];
    gameState.marketTips = [];
    gameState.messages = [];
    gameState.tradeRequests = {};
    gameState.gameConfig = {
      phase: 'waiting',
      startingBalance: 100000,
      adminPassword: 'admin123',
      currentRound: 0,
      totalRounds: 0,
      timeRemaining: 0,
      portfolioAllocationTime: 600,
      tradingRoundTime: 600,
      circuitLimitFrozen: false,
      marketTradingEnabled: false,
      shortSellingFrozen: false
    };
    
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

  socket.on('download_tradebook', (teamId, callback) => {
    let trades;
    if (teamId) {
      const team = gameState.teams[teamId];
      trades = team ? team.trades : [];
    } else {
      trades = gameState.trades;
    }
    
    let csv = 'Timestamp,Team,Action,Symbol,Quantity,Price,Total,Counterparty,Note\n';
    trades.forEach(trade => {
      const total = trade.quantity * trade.price;
      const counterparty = trade.counterparty || 'Market';
      const note = trade.note || '';
      csv += `${trade.timestamp},${trade.teamName},${trade.action},${trade.symbol},${trade.quantity},${trade.price},${total},${counterparty},${note}\n`;
    });
    
    callback({ success: true, csv: csv });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'trading.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 Mock Stock Trading Platform running on http://localhost:${PORT}`);
  console.log(`📊 Admin password: ${gameState.gameConfig.adminPassword}`);
});
