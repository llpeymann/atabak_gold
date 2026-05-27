import sys
import json
import pandas as pd
import mplfinance as mpf
import os
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.patches import FancyBboxPatch
from PIL import Image
from arabic_reshaper import reshape
from bidi.algorithm import get_display

# --- تنظیمات ---
FONT_FILENAME = "assets/Vazir.ttf" 
DEFAULT_BG_PATH = "assets/chartBg.png"
DPI = 160

current_dir = os.path.dirname(os.path.abspath(__file__))
font_path = os.path.join(current_dir, FONT_FILENAME)

def get_font_prop():
    if os.path.exists(font_path):
        return fm.FontProperties(fname=font_path)
    else:
        return fm.FontProperties(family="serif")

prop = get_font_prop()

def fix_persian(text):
    reshaped_text = reshape(text)
    bidi_text = get_display(reshaped_text)
    return bidi_text

def generate_chart(input_path, output_path, background_path=None):
    if not os.path.exists(input_path):
        sys.exit(1)

    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    df = pd.DataFrame(data)
    df['t'] = pd.to_datetime(df['t'], format='%H:%M')
    df.set_index('t', inplace=True)
    df = df.rename(columns={'o': 'Open', 'h': 'High', 'l': 'Low', 'c': 'Close'})

    # --- اصلاح ۱: تنظیم رنگ کندل‌ها به حالت استاندارد (سبز و قرمز) ---
    market_colors = mpf.make_marketcolors(
        up="#26a69a",    # سبز استاندارد تردینگ ویو
        down="#ef5350",  # قرمز استاندارد تردینگ ویو
        edge='inherit',
        wick='inherit', 
        volume='inherit'
    )
    
    style = mpf.make_mpf_style(
        base_mpf_style='nightclouds',
        marketcolors=market_colors,
        figcolor='none',
        facecolor='none',
        gridcolor='#FFFFFF', 
        gridstyle=':',
        rc={
            'axes.labelcolor': '#FFFFFF', 
            'xtick.color': '#FFFFFF',     
            'ytick.color': '#FFFFFF',     
            'grid.alpha': 0.15,            
        }
    )

    fig = plt.figure(figsize=(12, 7), dpi=DPI, facecolor='none')
    
    bg_ax = fig.add_axes([0, 0, 1, 1], zorder=0)
    bg_ax.axis('off')
    bg_to_use = background_path if background_path else DEFAULT_BG_PATH
    if bg_to_use and os.path.exists(bg_to_use):
        img = Image.open(bg_to_use).convert("RGBA")
        bg_ax.imshow(img, aspect='auto', extent=[0, 1, 0, 1])
    else:
        bg_ax.set_facecolor('#070708')

    panel_ax = fig.add_axes([0.05, 0.05, 0.90, 0.90], zorder=1)
    panel_ax.axis('off')
    glass_panel = FancyBboxPatch(
        (0, 0), 1, 1, boxstyle="round,pad=0,rounding_size=0.03", 
        facecolor=(0.04, 0.04, 0.04, 0.75), 
        edgecolor="#FFFFFF", 
        linewidth=0.8, transform=panel_ax.transAxes
    )
    panel_ax.add_patch(glass_panel)

    ax = panel_ax.inset_axes([0.05, 0.08, 0.90, 0.76], zorder=2)
    
    # --- اصلاح ۲: سفید کردن کامل محورها و تیک‌ها ---
    mpf.plot(df, type='candle', ax=ax, style=style, datetime_format='%H:%M')

    ax.set_facecolor('none')
    # تنظیم رنگ خطوط کادر (Spines) به سفید با شفافیت بالا
    for spine in ax.spines.values():
        spine.set_color('#FFFFFF') 
        spine.set_linewidth(1.0)
        spine.set_alpha(0.8)

    # اطمینان از سفید بودن تیک‌های محور طولی و عرضی
    ax.tick_params(axis='x', colors='#FFFFFF', labelsize=10)
    ax.tick_params(axis='y', colors='#FFFFFF', labelsize=10)

    title_string = "ATABAK GOLD"
    fig.text(0.5, 0.88, fix_persian(title_string), 
             ha='center', color='#FFFFFF', 
             fontsize=24, fontproperties=prop, weight='bold', zorder=3)

    plt.savefig(output_path, dpi=DPI, bbox_inches='tight', facecolor='none')
    plt.close(fig)

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        generate_chart(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else DEFAULT_BG_PATH)