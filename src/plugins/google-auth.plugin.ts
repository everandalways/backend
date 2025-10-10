import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { GoogleStrategy } from '../strategies/google.strategy';

@Controller('auth')
export class GoogleAuthController {
    @Get('google')
    @UseGuards(AuthGuard('google'))
    async googleAuth(@Req() req: Request) {
        // Initiates Google OAuth flow
    }

    @Get('google/callback')
    @UseGuards(AuthGuard('google'))
    async googleAuthRedirect(@Req() req: Request, @Res() res: Response) {
        // Handle Google OAuth callback
        const user = req.user;
        console.log('Google Auth Success:', user);
        // Redirect to your frontend with success
        res.redirect(`http://localhost:3000/auth/success`);
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [GoogleAuthController],
    providers: [GoogleStrategy],
})
export class GoogleAuthPlugin {}