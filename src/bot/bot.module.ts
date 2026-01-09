import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { User } from './models/user.entity';
import { ExtendersService } from './services/extenders.services';
import { DynamicCommandService } from './services/dynamic.service';
import { HelpCommand } from './commands/help/help.command';
import { BotGateway } from './events/bot.gateways';
import { ListenerChannelMessage } from './listeners/onChannelMessage.listener';
import { CommandBase } from './base/command.handle';
import { AvatarCommand } from './commands/avatar/avatar.command';

import { ListenerMessageButtonClicked } from './listeners/onMessageButtonClicked.listener';
import { ListenerTokenSend } from './listeners/tokensend.handle';
import { WelcomeMessageHandler } from './listeners/welcomeMessages';
import { WelcomeMessage } from './models/welcomeMessage.entity';
import { WelcomeMsgCommand } from './commands/welcomeMessages/welcomeMessages.command';
import { WelcomeMsgInfoCommand } from './commands/welcomeMessages/welcomeMessagesInfo.command';
import { RoleCommand } from './commands/selfAssignableRoles/role.command';
import { RoleService } from './commands/selfAssignableRoles/role.service';
import { WhiteListAddCommand } from './commands/selfAssignableRoles/whiteList';
// import { UnbanCommand } from './commands/ban/unban';
import { ScheduleModule } from '@nestjs/schedule';
import { AccBalanceCommand } from './commands/system/system.command';
import { ChkCommand } from './commands/admin/chk.command';
import { RutCommand } from './commands/system/rut.command';
import { PokerCommand } from './commands/poker/poker.command';
import { PokerService } from './commands/poker/poker.service';
import { PokerGame } from './models/poker.entity';

@Module({
  imports: [
    MulterModule.register({
      dest: './files',
    }),
    ScheduleModule.forRoot(),
    DiscoveryModule,
    TypeOrmModule.forFeature([User, WelcomeMessage, PokerGame]),
    HttpModule,
  ],
  providers: [
    CommandBase,
    BotGateway,
    ListenerChannelMessage,
    ListenerMessageButtonClicked,
    HelpCommand,
    AvatarCommand,
    ConfigService,
    ExtendersService,
    DynamicCommandService,
    ListenerTokenSend,
    WelcomeMessageHandler,
    WelcomeMsgCommand,
    WelcomeMsgInfoCommand,
    RoleCommand,
    RoleService,
    WhiteListAddCommand,
    // UnbanCommand,
    AccBalanceCommand,
    ChkCommand,
    RutCommand,
    PokerCommand,
    PokerService,
  ],
  controllers: [],
})
export class BotModule {}
