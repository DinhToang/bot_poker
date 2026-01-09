# 🃏 Mezon Poker Bot

Bot Texas Hold'em Poker cho Discord sử dụng Mezon SDK với Node.js 20 + TypeScript + NestJS.

## ✨ Tính năng

- 🎮 **Texas Hold'em Poker** - Chơi poker với bot dealer
- 🎯 **Multi-game Support** - Nhiều game cùng lúc trong 1 channel
- ⚡ **Immediate Start** - Game bắt đầu ngay khi đủ người tham gia
- 📊 **Action History** - Hiển thị lịch sử hành động của người chơi
- 🎲 **Hand Ranking** - Đánh giá bài chuẩn poker quốc tế
- 💰 **Token System** - Tích hợp với hệ thống token Mezon
- 🔄 **Real-time Updates** - Cập nhật trạng thái game real-time

## 🚀 Quick Start

### Yêu cầu hệ thống

- **Node.js**: >= 20.0.0
- **PostgreSQL**: >= 12.0
- **Mezon Account**: Để lấy token

### 1. Clone repository

```bash
git clone <repository-url>
cd bot-pocker
```

### 2. Cài đặt dependencies

```bash
npm install
# hoặc
yarn install
```

### 3. Cấu hình Environment Variables

Tạo file `.env` trong thư mục gốc:

```env
# Database Configuration
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=your_username
POSTGRES_PASSWORD=your_password
POSTGRES_DB=mezon_bot

# Mezon Configuration
MEZON_TOKEN=your_mezon_token

# Bot Configuration (Optional)
BOT_ID=your_bot_id
PORT=3000
```

### 4. Setup Database

````bash
# Tạo database PostgreSQL
createdb mezon_bot


### 5. Chạy ứng dụng

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm run start:prod
````

## 🎮 Cách sử dụng

### Lệnh Poker

#### Lệnh chính

- `*poker [token] @user1 @user2 @user3 ...` - Bắt đầu ván poker
  - Tự động thêm người gọi lệnh vào danh sách
  - Tối thiểu 2 người, tối đa 8 người

### Cách chơi

1. **Bắt đầu**: `*poker [token] @user1 @user2`
2. **Bot sẽ**:

   - Tạo game với danh sách người chơi
   - Chờ người chơi tham gia (có thể bắt đầu ngay khi đủ người)
   - Tự động phát 2 lá tẩy cho mỗi người
   - Đặt Small Blind (10) và Big Blind (20)
   - Bắt đầu vòng preflop

3. **Các vòng chơi**:
   - **Preflop**: Chỉ có 2 lá tẩy
   - **Flop**: Lật 3 lá community
   - **Turn**: Lật thêm 1 lá
   - **River**: Lật lá cuối
   - **Showdown**: So sánh bài

## 🏗️ Kiến trúc

### Cấu trúc thư mục

```
src/
├── bot/
│   ├── commands/           # Các lệnh bot
│   │   ├── poker/         # Lệnh poker
│   │   ├── admin/         # Lệnh admin
│   │   └── system/        # Lệnh hệ thống
│   ├── events/            # Event handlers
│   ├── listeners/         # Message listeners
│   ├── models/            # Database entities
│   ├── services/          # Business logic
│   └── utils/             # Utilities
├── mezon/                 # Mezon SDK integration
└── main.ts               # Entry point
```

### Công nghệ sử dụng

- **Framework**: NestJS
- **Database**: PostgreSQL + TypeORM
- **SDK**: Mezon SDK
- **Language**: TypeScript
- **Runtime**: Node.js 20+

## 🚀 Deployment

### Docker Deployment

1. **Tạo Dockerfile**:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

EXPOSE 3000

CMD ["node", "dist/main"]
```

2. **Tạo docker-compose.yml**:

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - '3000:3000'
    environment:
      - POSTGRES_HOST=db
      - POSTGRES_PORT=5432
      - POSTGRES_USER=mezon
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=mezon_bot
      - MEZON_TOKEN=${MEZON_TOKEN}
    depends_on:
      - db

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=mezon
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=mezon_bot
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

3. **Deploy**:

```bash
# Build và chạy
docker-compose up -d

# Xem logs
docker-compose logs -f app
```

### VPS/Cloud Deployment

1. **Cài đặt dependencies**:

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nodejs npm postgresql

# CentOS/RHEL
sudo yum install nodejs npm postgresql-server
```

2. **Setup PostgreSQL**:

```bash
# Tạo user và database
sudo -u postgres psql
CREATE USER mezon WITH PASSWORD 'password';
CREATE DATABASE mezon_bot OWNER mezon;
GRANT ALL PRIVILEGES ON DATABASE mezon_bot TO mezon;
\q
```

3. **Deploy ứng dụng**:

```bash
# Clone và build
git clone <repository-url>
cd bot-pocker
npm install
npm run build

# Chạy với PM2
npm install -g pm2
pm2 start dist/main.js --name "mezon-poker-bot"
pm2 save
pm2 startup
```

### Environment Variables

| Variable            | Required | Description              | Example           |
| ------------------- | -------- | ------------------------ | ----------------- |
| `POSTGRES_HOST`     | ✅       | PostgreSQL host          | `localhost`       |
| `POSTGRES_PORT`     | ✅       | PostgreSQL port          | `5432`            |
| `POSTGRES_USER`     | ✅       | PostgreSQL username      | `mezon`           |
| `POSTGRES_PASSWORD` | ✅       | PostgreSQL password      | `password`        |
| `POSTGRES_DB`       | ✅       | PostgreSQL database name | `mezon_bot`       |
| `MEZON_TOKEN`       | ✅       | Mezon API token          | `your_token_here` |
| `BOT_ID`            | ❌       | Bot ID (optional)        | `bot_123`         |
| `PORT`              | ❌       | Application port         | `3000`            |

## 🔧 Development

### Scripts

```bash
# Development
npm run dev              # Chạy với watch mode
npm run start:debug      # Chạy với debug mode

# Building
npm run build           # Build production
npm run start:prod      # Chạy production build

# Testing
npm run test            # Chạy unit tests
npm run test:watch      # Chạy tests với watch mode
npm run test:cov        # Chạy tests với coverage
npm run test:e2e        # Chạy e2e tests

# Database
npm run migration:generate  # Tạo migration mới
npm run migration:run       # Chạy migrations
npm run migration:revert    # Revert migration cuối

# Code Quality
npm run lint            # Chạy ESLint
npm run format          # Format code với Prettier
```

### Cấu trúc Database

#### User Entity

```typescript
{
  user_id: string; // Discord user ID
  username: string; // Username
  display_name: string; // Display name
  amount: number; // Token balance
  roleClan: object; // Clan roles
  createdAt: number; // Creation timestamp
}
```

#### PokerGame Entity

```typescript
{
  id: string;                // Game ID
  clan_id: string;           // Clan ID
  channel_id: string;        // Channel ID
  creator_id: string;        // Creator user ID
  status: string;            // Game status
  pot: number;               // Total pot
  current_bet: number;       // Current bet amount
  round: string;             // Current round
  players: object[];         // Players data
  board: string[];           // Community cards
  action_history: object[];  // Action history
  createdAt: Date;           // Creation date
  updatedAt: Date;           // Last update date
}
```

## 🐛 Troubleshooting

### Lỗi thường gặp

1. **Database connection failed**

   ```bash
   # Kiểm tra PostgreSQL đang chạy
   sudo systemctl status postgresql

   # Kiểm tra connection
   psql -h localhost -U mezon -d mezon_bot
   ```

2. **Mezon token invalid**

   ```bash
   # Kiểm tra token trong .env
   echo $MEZON_TOKEN

   # Test connection
   curl -H "Authorization: Bearer $MEZON_TOKEN" https://api.mezon.vn/health
   ```

3. **Port already in use**

   ```bash
   # Tìm process đang dùng port
   lsof -i :3000

   # Kill process
   kill -9 <PID>
   ```

### Logs

```bash
# Xem logs ứng dụng
pm2 logs mezon-poker-bot

# Xem logs database
sudo journalctl -u postgresql

# Xem logs system
sudo journalctl -f
```

## 📝 API Reference

### Poker Service Methods

```typescript
// Tạo game mới
createGame(clanId: string, channelId: string, creatorId: string, mentionedUsers: User[]): Promise<GameResult>

// Tham gia game
joinGame(gameId: string, userId: string, channelId: string, clanId: string): Promise<GameResult>

// Thực hiện hành động
makeCall(gameId: string, userId: string, channelId: string, clanId: string): Promise<GameResult>
makeRaise(gameId: string, userId: string, toTotal: number, channelId: string, clanId: string): Promise<GameResult>
makeCheck(gameId: string, userId: string, channelId: string, clanId: string): Promise<GameResult>
makeFold(gameId: string, userId: string, channelId: string, clanId: string): Promise<GameResult>
makeAllIn(gameId: string, userId: string, channelId: string, clanId: string): Promise<GameResult>
```

## 🤝 Contributing

1. Fork repository
2. Tạo feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push branch: `git push origin feature/amazing-feature`
5. Tạo Pull Request

## 📄 License

This project is licensed under the UNLICENSED License.

## 🆘 Support

Nếu gặp vấn đề, vui lòng tạo issue trên GitHub hoặc liên hệ team phát triển.

---

**Made with ❤️ by  Teamm**
