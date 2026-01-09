import {
  ChannelMessage,
  EButtonMessageStyle,
  EMarkdownType,
  EMessageComponentType,
} from 'mezon-sdk';
import { CommandMessage } from '../../base/command.abstract';
import { Command } from '../../base/commandRegister.decorator';
import { PokerService } from './poker.service';
import { MezonClientService } from '../../../mezon/services/mezon-client.service';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from '../../models/user.entity';
import { Repository } from 'typeorm';

@Command('poker')
export class PokerCommand extends CommandMessage {
  constructor(
    private pokerService: PokerService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    clientService: MezonClientService,
  ) {
    super(clientService);
  }

  async execute(args: string[], message: ChannelMessage): Promise<void> {
    if (!args || args.length === 0) {
      await this.replyMessage(message, '❌ Sử dụng: `*poker <command> [args]`');
      return;
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    try {
      switch (true) {
        case Number(command) > 0:
          await this.handleStart(commandArgs, message, Number(command));
          break;
        default:
          await this.replyMessage(
            message,
            '❌ Lệnh không hợp lệ. Sử dụng: `*poker [betAmount]`\n📖 **Hướng dẫn:**\n- `*poker start` - Tạo game giữa người chơi (mặc định)\n- `*poker start 2000` - Tạo game với mức cược 2000',
          );
      }
    } catch (error) {
      await this.replyMessage(message, `❌ Lỗi: ${error.message}`);
    }
  }

  private async handleStart(
    args: string[],
    message: ChannelMessage,
    amountBet: number,
  ): Promise<void> {
    const mentions = message.mentions || [];
    const creatorId = message.sender_id;
    const clanId = message.clan_id!;
    const channelId = message.channel_id!;
    const messageId = message.message_id!;

    let betAmount = amountBet || 1000;

    if (
      mentions.length === 0 ||
      mentions.some((m) => m.user_id === creatorId)
    ) {
      await this.replyMessage(
        message,
        '❌ Cần mention ít nhất 1 người chơi để bắt đầu game',
      );
      return;
    }

    // Check if first argument is a number (bet amount)
    if (args.length > 0) {
      if (betAmount <= 0) {
        await this.replyMessage(message, '❌ Số tiền cược phải lớn hơn 0');
        return;
      }
    }

    const mentionUsers = await Promise.all(
      mentions.map(async (m) => {
        const findUser = await this.userRepository.findOne({
          where: { user_id: m.user_id },
        });
        return { idUser: m.user_id, name: findUser?.username };
      }),
    );

    const allPlayerIds = new Set([
      { idUser: creatorId, name: message.username },
      ...mentionUsers,
    ]);

    // Check minimum players
    if (allPlayerIds.size < 2) {
      await this.replyMessage(
        message,
        '❌ Cần ít nhất 2 người chơi để bắt đầu game',
      );
      return;
    }

    if (allPlayerIds.size > 8) {
      await this.replyMessage(message, '❌ Tối đa 8 người chơi');
      return;
    }

    // Check if all players have enough money
    const realPlayers = Array.from(allPlayerIds).filter(
      (user: { idUser: string; name: string }) => user.idUser,
    );

    const insufficientFundsCheck = await this.pokerService.checkPlayersFunds(
      realPlayers,
      betAmount,
    );

    if (!insufficientFundsCheck.success) {
      await this.replyMessage(message, `❌ ${insufficientFundsCheck.message}`);
      return;
    }

    try {
      const allPlayers = Array.from(allPlayerIds).filter(
        (user: any) => user.idUser,
      ) as { idUser: string; name: string }[];

      const inviteResult = await this.pokerService.createInvite(
        creatorId,
        clanId,
        channelId,
        messageId,
        allPlayers,
        betAmount,
      );

      if (!inviteResult.success) {
        await this.replyMessage(message, `❌ ${inviteResult.message}`);
        return;
      }

      // Tạo button components
      const components = [
        {
          components: [
            {
              id: `poker_join_${inviteResult.gameId}_${clanId}_${channelId}`,
              type: EMessageComponentType.BUTTON,
              component: {
                label: '🎯 Tham gia',
                style: EButtonMessageStyle.SUCCESS,
              },
            },
            {
              id: `poker_decline_${inviteResult.gameId}_${clanId}_${channelId}`,
              type: EMessageComponentType.BUTTON,
              component: {
                label: '❌ Từ chối',
                style: EButtonMessageStyle.DANGER,
              },
            },
          ],
        },
      ];

      // Gửi invite message
      const realPlayers = Array.from(allPlayerIds).filter((user: any) => ({
        idUser: user?.idUser,
        name: user?.name,
      }));
      const playerMentions = realPlayers
        .map((user: any) => `<@${user.name}>`)
        .join(' ');

      const messageChannel = await this.getChannelMessage(message);
      if (messageChannel) {
        const inviteMessage = `🎴 **Poker Invite** 
${playerMentions} được mời chơi Texas Hold'em giữa các người chơi!
📊 **Chi tiết:**
- 👥 Người chơi: ${realPlayers.length}/8
- 💰 Số tiền cược: ${betAmount} token
⏰ **Chọn trong 30 giây, game sẽ tự động bắt đầu!**`;

        const replyMessage = await messageChannel.reply({
          t: inviteMessage,
          components: components,
          mk: [{ type: EMarkdownType.PRE, s: 0, e: inviteMessage.length }], // Hiển thị buttons cho tất cả trường hợp
        });

        if (replyMessage) {
          await this.pokerService.setInviteMessageId(
            inviteResult.gameId,
            replyMessage.message_id!,
            clanId,
            channelId,
          );
        }
      }
    } catch (error) {
      await this.replyMessage(
        message,
        `❌ Không thể tạo invite: ${error.message}`,
      );
    }
  }

  private async replyMessage(
    message: ChannelMessage,
    content: string,
  ): Promise<void> {
    try {
      const messageChannel = await this.getChannelMessage(message);
      if (messageChannel) {
        await messageChannel.reply({
          t: content,
          mk: [{ type: EMarkdownType.PRE, s: 0, e: content.length }],
        });
      }
    } catch (error) {
      // Error handling
    }
  }
}
