import { Module } from '@nestjs/common';
import Joi from 'joi';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from './bot/bot.module';
import { MezonModule } from './mezon/mezon.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    ConfigModule.forRoot({
      validationSchema: Joi.object({
        // POSTGRES_HOST: Joi.string().required(),
        // POSTGRES_PORT: Joi.number().required(),
        // POSTGRES_USER: Joi.string().required(),
        // POSTGRES_PASSWORD: Joi.string().required(),
        // POSTGRES_DB: Joi.string().required(),
        PRISMA_DATABASE_URL: Joi.string().required(),
        MEZON_TOKEN: Joi.string().required(),
      }),
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
         url:
          configService.get<string>('PRISMA_DATABASE_URL') ||
          configService.get<string>('POSTGRES_URL'),

        autoLoadEntities: true,

        // ❌ KHÔNG dùng production
        synchronize: false,

        // ✅ BẮT BUỘC cho Vercel Postgres
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
        // host: configService.get('POSTGRES_HOST'),
        // port: configService.get('POSTGRES_PORT'),
        // username: configService.get('POSTGRES_USER'),
        // password: configService.get('POSTGRES_PASSWORD'),
        // database: configService.get('POSTGRES_DB'),
        // autoLoadEntities: true,
        // synchronize: true,
        // migrations: [path.join(__dirname, 'src', 'migration', '*.js')],
        // cli: {
        //   migrationsDir: __dirname + '/migration',
        // },
      }),
    }),
    MezonModule.forRootAsync({
      imports: [ConfigModule],
    }),
    BotModule,
  ],
})
export class AppModule {}
