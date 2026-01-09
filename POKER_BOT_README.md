# Mezon Poker Dealer Bot

Bot Texas Hold'em Poker cho Mezon SDK với Node.js 20 + TypeScript.

## Cài đặt

```bash
npm install
```

## Chạy bot

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Lệnh Poker

### Lệnh chính

- `!poker start @user1 @user2 @user3 ...` - Bắt đầu ván poker
  - Tự động thêm người gọi lệnh vào danh sách
  - Tối thiểu 2 người, tối đa 10 người
  - Nếu không mention ai: tạo ván 1v1 với Dealer

### Lệnh phụ

- `!poker board` - Xem board hiện tại và pot
- `!poker status` - Xem trạng thái game, lượt chơi, chip
- `!poker bet <amount>` - Bet số tiền
- `!poker raise <toTotal>` - Raise lên tổng số tiền
- `!poker call` - Call bet hiện tại
- `!poker check` - Check (không bet)
- `!poker fold` - Fold (bỏ bài)
- `!poker allin` - All-in (cược hết)
- `!poker showdown` - Ép showdown ngay
- `!poker end` - Kết thúc game (chỉ người tạo)

## Cách chơi

1. **Bắt đầu**: `!poker start @user1 @user2`
2. **Bot sẽ**:

   - Tạo game với danh sách người chơi
   - Chờ 30 giây để người chơi tham gia
   - Tự động phát 2 lá tẩy cho mỗi người (sendEphemeral)
   - Đặt Small Blind (10) và Big Blind (20)
   - Bắt đầu vòng preflop

3. **Các vòng chơi**:

   - **Preflop**: Chỉ có 2 lá tẩy
   - **Flop**: Lật 3 lá community
   - **Turn**: Lật thêm 1 lá
   - **River**: Lật lá cuối
   - **Showdown**: So sánh bài với Dealer

4. **Dealer (Bot)**:
   - Có 2 lá ẩn
   - Chỉ show ở showdown
   - So sánh với từng người chơi

## Luật chơi

- **Hand Ranking**: Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > One Pair > High Card
- **Ace**: Có thể thấp cho wheel (A-2-3-4-5)
- **Blinds**: SB=10, BB=20
- **Starting Chips**: 1000 mỗi người
- **Win Condition**: Thắng Dealer để lấy pot

## Cấu trúc Code

```
src/bot/commands/poker/
├── poker.command.ts    # Xử lý lệnh !poker
├── poker.service.ts    # Logic game poker
└── poker.entity.ts     # Database entity

src/bot/models/
└── poker.entity.ts     # TypeORM entity
```

## Database

- **Table**: `poker_games`
- **Fields**: id, clanId, channelId, creatorId, gameState, isActive, createdAt, updatedAt
- **Game State**: Lưu toàn bộ trạng thái game dưới dạng JSON

## Tính năng mới

- ✅ **Auto Deal**: Tự động phát bài sau 30 giây
- ✅ **Ephemeral Messages**: Gửi bài riêng tư bằng sendEphemeral
- ✅ **Game States**: Quản lý trạng thái waiting/preflop/flop/turn/river/showdown
- ✅ **Timeout Management**: Tự động cleanup timeout khi kết thúc game

## TODO

- [ ] Implement hand evaluation logic
- [ ] Add side pot support
- [ ] Add tournament mode
- [ ] Add statistics tracking
- [ ] Add emoji reactions for actions
- [ ] Add manual deal command (skip 30s wait)
