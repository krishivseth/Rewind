import img_house_figure_cutout from './images/house-figure-cutout.png';
import React from 'react';

export default function DeepOrangePoster() {
  return (
    <div 
      className="relative w-full h-full bg-[#E5390B] flex flex-col justify-between overflow-hidden text-white"
      style={{ fontFamily: '"Playfair Display", serif', width: '100%', height: '100%', aspectRatio: '1/1' }}
    >
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap');
      `}} />

      {/* Top Masthead */}
      <div className="relative z-20 px-12 pt-12">
        <h1 className="text-[52px] tracking-[0.25em] font-black uppercase text-center mb-8 pl-[0.25em]">
          Deep Orange
        </h1>
        <div className="w-full border-t-[1.5px] border-white" />
      </div>

      {/* Middle Huge Text */}
      <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none select-none px-4">
        <div 
          className="w-full flex justify-between"
          style={{ 
            fontSize: '260px', 
            fontWeight: 900, 
            lineHeight: 0.8, 
            transform: 'scaleY(1.15)' 
          }}
        >
          <span>H</span>
          <span>O</span>
          <span>U</span>
          <span>S</span>
          <span>E</span>
        </div>
      </div>

      {/* Subject Figure Image */}
      <div className="absolute inset-0 z-15 flex items-end justify-center pointer-events-none">
        <img 
          src={img_house_figure_cutout} 
          alt="Subject"
          className="w-full h-[85%] object-cover object-bottom"
          style={{ 
            filter: 'contrast(1.15) brightness(0.95)',
          }} 
        />
      </div>

      {/* Bottom Block */}
      <div className="relative z-20 px-12 pb-12 flex flex-col w-full">
        <div className="w-full border-t-[1.5px] border-white" />
        <div className="py-4 text-[26px] tracking-[0.3em] font-bold uppercase text-center pl-[0.3em]">
          Saturday 24 August 2024
        </div>
        <div className="w-full border-t-[1.5px] border-white" />
        <div className="py-4 text-[42px] tracking-[0.15em] font-black uppercase text-center flex items-center justify-center gap-4 pl-[0.15em]">
          The Foundry <span className="text-[28px] font-bold mt-1">London</span>
        </div>
        <div className="w-full border-t-[1.5px] border-white" />
        <div className="py-4 text-[22px] tracking-[0.25em] font-bold uppercase text-center pl-[0.25em]">
          Max Lowe &middot; Paolo Rocco &middot; Juliet Fox
        </div>
        <div className="w-full border-t-[1.5px] border-white" />
        <div className="py-4 text-[18px] tracking-[0.2em] font-semibold uppercase text-center pl-[0.2em]">
          Doors 11pm &middot; Tickets: ResidentAdvisor.net
        </div>
        <div className="w-full border-t-[1.5px] border-white" />
      </div>
    </div>
  );
}
