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
    console.log('Google OAuth callback hit');
    try {
        const user = req.user as any;
        
        console.log('Google user data:', user); // Debug log
        
        if (!user || !user.email) {
            console.error('No user data from Google');
            return res.redirect('http://localhost:8002/account/sign-in?error=no-user-data');
        }

        // For now, just redirect with user info
        // We'll add proper customer creation next
        return res.redirect(`http://localhost:8002/account?email=${user.email}&name=${user.firstName}`);
        
    } catch (error) {
        console.error('Google OAuth callback error:', error);
        return res.redirect('http://localhost:8002/account/sign-in?error=callback-failed');
    }
}
}

@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [GoogleAuthController],
    providers: [GoogleStrategy],
})
export class GoogleAuthPlugin {}